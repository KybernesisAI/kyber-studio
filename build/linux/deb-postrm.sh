#!/bin/bash
# postrm for the Ubuntu .deb — KYB-543.
#
# REPLACES electron-builder's stock after-remove.tpl, so the stock behaviour is
# reproduced here as well as the new AppArmor teardown.
#
# Same templating trap as the postinst: ${...} in [a-zA-Z] is substituted at
# PACKAGE time and an unknown macro fails the build, so shell variables here are
# $BARE or ${UPPER_SNAKE_CASE} only.

set -e

PROFILE_PATH='/etc/apparmor.d/${executable}'

# ── stock after-remove.tpl, reproduced verbatim ────────────────────────────
#
# Deliberately not guarded on "$1", matching stock. On an upgrade dpkg runs the
# OLD postrm with "upgrade" and then the NEW postinst with "configure", which
# re-creates this link — so removing it unconditionally is safe, and diverging
# from stock here would be an unrelated behaviour change riding in this ticket.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# ── AppArmor profile teardown ──────────────────────────────────────────────
#
# Guarded on "$1", unlike the above, and for a reason that is not symmetry:
# unloading the profile during an UPGRADE would leave the app with no userns
# grant for the window between this script and the new postinst, and if the
# upgrade then failed part-way it would leave a machine that had the profile
# before and does not now. On remove and purge there is nothing left to grant.
case "$1" in
    remove|purge)
        if [ -f "$PROFILE_PATH" ]; then
            # Unload before deleting: removing the file alone leaves the profile
            # resident in the kernel until reboot, so an "uninstall, reinstall"
            # cycle would be comparing against a stale in-kernel copy.
            if command -v apparmor_parser >/dev/null 2>&1; then
                apparmor_parser --remove "$PROFILE_PATH" >/dev/null 2>&1 || true
            fi
            rm -f "$PROFILE_PATH"
        fi
        # The cache entry, if the parser wrote one. Left behind it would be
        # loaded at boot by a package that is no longer installed.
        rm -f /etc/apparmor.d/cache/${executable} 2>/dev/null || true
        rm -f /var/cache/apparmor/*/${executable} 2>/dev/null || true
        ;;
esac
