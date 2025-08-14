#!/usr/bin/env node

const { transformFileSync } = require("@babel/core");
const path = require("path");
const fs = require("fs");

// load your plugin
const floatedBindingPlugin = require("./lib.js");

// take file from CLI args
const file = process.argv[2];
if (!file) {
  console.error("Usage: node run-floated-binding.js <file.js>");
  process.exit(1);
}

const filePath = path.resolve(file);

// Check if file exists
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

// Check file size (15MB = 15 * 1024 * 1024 bytes)
const source = fs.readFileSync(filePath, 'utf8');
const maxSize = 15 * 1024 * 1024;
if (source.length > maxSize) {
  console.error(`File too large: ${(source.length / 1024 / 1024).toFixed(2)}MB (max: 15MB)`);
  process.exit(1);
}

try {
  // run babel transform - the 500KB warning is just about styling, transformation still works
  const { code } = transformFileSync(filePath, {
    plugins: [floatedBindingPlugin],
    compact: false,
    minified: false,
  });

  // Write the transformed code back to the same file
  fs.writeFileSync(filePath, code, 'utf8');
  
  console.log(`Successfully transformed and updated: ${filePath}`);
} catch (error) {
  console.error(`Error transforming file: ${error.message}`);
  process.exit(1);
}
