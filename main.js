#!/usr/bin/env node

const { transformFileSync } = require("@babel/core");
const path = require("path");

// load your plugin
const floatedBindingPlugin = require("./lib.js");

// take file from CLI args
const file = process.argv[2];
if (!file) {
  console.error("Usage: node run-floated-binding.js <file.js>");
  process.exit(1);
}

// Check file size (15MB = 15 * 1024 * 1024 bytes)
const fs = require("fs");
const source = fs.readFileSync(path.resolve(file), 'utf8');
const maxSize = 15 * 1024 * 1024;
if (source.length > maxSize) {
  console.error(`File too large: ${(source.length / 1024 / 1024).toFixed(2)}MB (max: 15MB)`);
  process.exit(1);
}

// run babel transform - the 500KB warning is just about styling, transformation still works
const { code } = transformFileSync(path.resolve(file), {
  plugins: [floatedBindingPlugin],
  compact: false,
  minified: false,
});

console.log(code);
