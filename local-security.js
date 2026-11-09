"use strict";
const fs = require("fs"), path = require("path");
function inside(file, root) {
  try { const f = fs.realpathSync(file), r = fs.realpathSync(root); return f === r || f.startsWith(r + path.sep); } catch { return false; }
}
function allowedInput(file) {
  const roots = process.env.FABLECUT_INPUT_ROOTS;
  if (roots && !roots.split(path.delimiter).some(root => inside(file, root))) throw new Error("input is outside approved folders");
  return file;
}
module.exports = { inside, allowedInput };
