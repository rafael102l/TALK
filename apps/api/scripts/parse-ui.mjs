import fs from "fs";
const x = fs.readFileSync("C:/TALK/ui.xml", "utf8");
const re = /text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
let m;
while ((m = re.exec(x))) {
  if (m[1]) console.log(JSON.stringify({ t: m[1], b: [m[2], m[3], m[4], m[5]].map(Number) }));
}
