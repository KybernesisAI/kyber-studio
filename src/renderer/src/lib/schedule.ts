/**
 * Schedules in human terms.
 *
 * A cron expression is a fine storage format and a terrible thing to ask a
 * person for. Nobody writing "send me a digest on weekday mornings" thinks
 * `40 8 * * 1-5`, and getting it subtly wrong — day-of-week numbering, a stray
 * `*` in the minute field — produces a routine that runs sixty times an hour
 * without ever looking broken.
 *
 * So the UI collects a frequency and a time, this module compiles it, and the
 * cron it produced is shown back as plain English for confirmation.
 */

export type Frequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "interval" | "custom";

export interface ScheduleSpec {
  frequency: Frequency;
  /** Minutes past the hour, for hourly. */
  minute: number;
  /** 0–23, for daily/weekdays/weekly/monthly. */
  hour: number;
  /** 0 = Sunday, for weekly. */
  weekday: number;
  /** 1–28, for monthly. Capped at 28 so every month actually has the day. */
  day: number;
  /** Minutes between runs, for interval. */
  everyMinutes: number;
  /** Raw cron, for custom. */
  cron: string;
}

export const DEFAULT_SPEC: ScheduleSpec = {
  frequency: "weekdays",
  minute: 0,
  hour: 9,
  weekday: 1,
  day: 1,
  everyMinutes: 30,
  cron: "0 9 * * 1-5",
};

export const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "interval", label: "Interval" },
  { value: "custom", label: "Advanced (cron)" },
];

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Quarter-hour slots across the day, as a person picks a time. */
export function timeOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      out.push({ value: `${h}:${m}`, label: formatTime(h, m) });
    }
  }
  return out;
}

export function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function toCron(spec: ScheduleSpec): string {
  const { minute, hour, weekday, day, everyMinutes } = spec;
  switch (spec.frequency) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      // 1-5 is Monday to Friday. Written as a range rather than a list because
      // the range is what people mean by "weekdays" and reads correctly if
      // anyone opens the generated file.
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} ${day} * *`;
    case "interval":
      return everyMinutes >= 60 && everyMinutes % 60 === 0
        ? `0 */${everyMinutes / 60} * * *`
        : `*/${Math.max(1, Math.min(59, everyMinutes))} * * * *`;
    case "custom":
      return spec.cron.trim();
  }
}

/**
 * Cron back to English, for confirming what was just built and for describing
 * schedules the agent already has — which were authored in its repo and may be
 * anything at all, so this falls back to the raw expression rather than
 * guessing at a shape it does not recognize.
 */
export function describeCron(cron?: string): string {
  if (!cron) return "No schedule";
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hr, dom, , dow] = parts as [string, string, string, string, string];

  const at = (h: string, m: string): string => {
    const hour = Number(h);
    const minute = Number(m);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return `at ${h}:${m}`;
    return `at ${formatTime(hour, minute)}`;
  };

  if (min.startsWith("*/") && hr === "*") return `Every ${min.slice(2)} minutes`;
  if (hr.startsWith("*/")) return `Every ${hr.slice(2)} hours`;
  if (hr === "*" && /^\d+$/.test(min)) {
    return min === "0" ? "Every hour, on the hour" : `Every hour at :${min.padStart(2, "0")}`;
  }

  if (/^\d+$/.test(hr) && /^\d+$/.test(min)) {
    const time = at(hr, min);
    if (dow === "1-5") return `Weekdays ${time}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends ${time}`;
    if (/^\d$/.test(dow)) return `Every ${WEEKDAYS[Number(dow)] ?? dow} ${time}`;
    if (/^\d+$/.test(dom)) return `Monthly on day ${dom} ${time}`;
    return `Every day ${time}`;
  }
  return cron;
}
