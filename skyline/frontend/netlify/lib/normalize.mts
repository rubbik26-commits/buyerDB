const SUFFIX: Record<string, string> = { STREET: "ST", ST: "ST", AVENUE: "AVE", AVE: "AVE", BOULEVARD: "BLVD", BLVD: "BLVD", ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR", LANE: "LN", LN: "LN", COURT: "CT", CT: "CT", PLACE: "PL", PL: "PL", PARKWAY: "PKWY", PKWY: "PKWY", HIGHWAY: "HWY", HWY: "HWY", TERRACE: "TER", TER: "TER" };
const DIRECTION: Record<string, string> = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
const GENERIC = new Set([...Object.values(SUFFIX), ...Object.values(DIRECTION), "THE", "OF", "LA", "DE"]);
export const BOROUGH_CODE: Record<string, string> = { Manhattan: "1", Bronx: "2", Brooklyn: "3", Queens: "4", "Staten Island": "5" };

export function canonStreet(value: unknown) {
  return String(value || "").toUpperCase().replace(/[.,#]/g, " ").replace(/\b(\d+)(ST|ND|RD|TH)\b/g, "$1").split(/\s+/).filter(Boolean).map(token => DIRECTION[token] || SUFFIX[token] || token).join(" ");
}
export function splitAddress(address: string) {
  const match = String(address || "").toUpperCase().match(/^\s*([0-9]+(?:-[0-9]+)?)\s+(.+?)(?:\s+(?:MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND)(?:\s+NY)?)?\s*$/);
  return match ? [match[1], canonStreet(match[2])] : [null, null];
}
export function keyToken(name: string | null) {
  const tokens = String(name || "").split(" ").filter(token => token && !GENERIC.has(token));
  return tokens.sort((a, b) => b.length - a.length)[0] || null;
}
export function quote(value: unknown) { return String(value || "").replaceAll("'", "''"); }
export function dayDistance(a: unknown, b: unknown) { const x = Date.parse(String(a || "")), y = Date.parse(String(b || "")); return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / 86400000 : 9999; }
export function agreed(values: unknown[]) { const nums = [...new Set(values.map(Number).filter(value => Number.isFinite(value) && value > 0).map(Math.trunc))]; return nums.length === 1 ? nums[0] : null; }
