const tehranDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Returns the YYYY-MM-DD calendar date in Asia/Tehran (UTC+03:30).
 */
export function getTehranDateString(date: Date = new Date()): string {
  return tehranDateFormatter.format(date);
}
