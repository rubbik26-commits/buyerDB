export function downloadCsv(filename, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  const headers = Array.from(new Set(list.flatMap((r) => Object.keys(r || {}))));
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) value = value.join("; ");
    if (typeof value === "object") value = JSON.stringify(value);
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...list.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
