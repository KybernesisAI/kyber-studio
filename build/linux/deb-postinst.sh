#!/bin/bash
# postinst for the Ubuntu .deb — KYB-543.
#
# This REPLACES electron-builder's stock after-install.tpl rather than adding to
# it, so everything the stock template did has to be here too. The stock parts
# are reproduced verbatim below and marked; the new parts are the AppArmor
# profile and an explicit decision about chrome-sandbox.
#
# TEMPLATING, AND A TRAP WORTH KNOWING. electron-builder passes this file
# through the same macro substitution as its own templates: every ${...}
# matching /\$\{([a-zA-Z]+)\}/ is replaced at PACKAGE time, and an unknown macro
# THROWS, failing the build. Defined here are executable, sanitizedProductName,
# productFilename, and every key of build.linux.
#
#   => Shell variables in this file must be $BARE or ${UPPER_SNAKE_CASE}.
#      Underscores and digits are outside [a-zA-Z], so those forms are invisible
#      to the substitution. A lowercase a lowercase macro would be eaten, or would fail the
#      package build outright.
#
# That is also why the install path is interpolated at package time rather than
# reconstructed at run time: '/opt/${sanitizedProductName}' arrives here already
# spelled correctly, space and all, and only needs quoting.

set -e

APP_DIR='/opt/${sanitizedProductName}'
PROFILE_PATH='/etc/apparmor.d/${executable}'

# ── stock after-install.tpl, reproduced ────────────────────────────────────
if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# ── chrome-sandbox: 0755, stated rather than inherited ─────────────────────
#
# The stock template decides this by probing user namespaces AS ROOT AT INSTALL
# TIME:
#
#     if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
#         chmod 4755 .../chrome-sandbox
#     else
#         chmod 0755 .../chrome-sandbox
#     fi
#
# Root can always unshare, so the probe succeeds and the SUID bit is skipped —
# regardless of what the unprivileged user who launches the app will get. On
# stock Ubuntu 24.04+ that user gets neither: apparmor_restrict_unprivileged_userns=1
# denies the userns sandbox, and there is no SUID helper to fall back to.
#
# The SUID fallback could not have worked here in any case. Chromium's
# LaunchProcess truncates the sandbox helper path at the first space, and this
# app installs to a directory with one in it (KYB-508 UAT, Ubuntu 26.04,
# 2 September 2026). The path cannot be changed from the Linux side: fpm builds
# it from appInfo.sanitizedProductName, which comes from the top-level
# build.productName that also brands the macOS .dmg.
#
# So the profile below has to make user namespaces WORK. There is no fallback to
# fall back to, and 0755 is the honest mode to ship: not a probe result, a
# consequence of the profile.
chmod 0755 "$APP_DIR/chrome-sandbox" || true

# ── AppArmor profile ───────────────────────────────────────────────────────
#
# Stock Ubuntu 24.04+/26.04 sets kernel.apparmor_restrict_unprivileged_userns=1,
# which denies unprivileged user namespaces to unconfined programs. Chromium
# needs one for its sandbox. The grant is a profile that is otherwise unconfined
# and carries the userns rule.
#
# The attachment path is quoted because it contains a space. It is interpolated
# at package time, so it cannot drift from where fpm actually installs the app.
if command -v apparmor_parser >/dev/null 2>&1; then
    PROFILE_TMP="$(mktemp)"
    cat > "$PROFILE_TMP" <<'APPARMOR_PROFILE'
# Managed by the ${sanitizedProductName} package (KYB-543). Local changes belong
# in /etc/apparmor.d/local/${executable}, which is included below and is never
# touched by this package.
abi <abi/4.0>,

include <tunables/global>

profile ${executable} "/opt/${sanitizedProductName}/${executable}" flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
APPARMOR_PROFILE

    # DRY RUN FIRST, and this is load-bearing rather than defensive.
    #
    # `abi <abi/4.0>` is AppArmor 4 syntax. A machine with an older parser — or
    # one where this profile is rejected for any other reason — must still end
    # up with a working installation, because a postinst that exits non-zero
    # leaves dpkg half-configured, which is a worse failure than having no
    # profile at all. On such a machine the userns restriction is generally not
    # in force either, so the sandbox works without us.
    if apparmor_parser --skip-kernel-load --quiet "$PROFILE_TMP" 2>/dev/null; then
        install -m 0644 "$PROFILE_TMP" "$PROFILE_PATH"
        # Load it now so the app works before the next reboot. A running kernel
        # without AppArmor enabled will refuse; that is not a packaging failure.
        apparmor_parser --replace --write-cache "$PROFILE_PATH" >/dev/null 2>&1 \
            || echo "${sanitizedProductName}: AppArmor profile installed but not loaded; it will apply after a reboot." >&2
    else
        echo "${sanitizedProductName}: this system's apparmor_parser rejected the profile, so it was not installed." >&2
        echo "${sanitizedProductName}: if the app cannot start its sandbox, see /usr/share/doc/${executable}." >&2
    fi
    rm -f "$PROFILE_TMP"
fi

# ── stock after-install.tpl, reproduced ────────────────────────────────────
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
