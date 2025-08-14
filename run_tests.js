#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import * as diff from 'diff';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function displayDiff(expected, actual) {
  console.log(chalk.bold('\n📊 Visual Diff:'));
  console.log('─'.repeat(60));

  const changes = diff.diffLines(expected, actual);

  changes.forEach((part) => {
    const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
    const color = part.added ? chalk.green : part.removed ? chalk.red : chalk.gray;

    part.value.split('\n').forEach((line, index, lines) => {
      if (index === lines.length - 1 && line === '') return;
      console.log(color(`${prefix}${line}`));
    });
  });

  console.log('─'.repeat(60));
}

function runTests() {
  const testDir = path.join(__dirname, './test_data');
  const mainScript = path.join(__dirname, './main.js');

  console.log(chalk.bold.blue('🧪 Test Results\n'));

  try {
    const subdirs = fs
      .readdirSync(testDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();

    if (subdirs.length === 0) {
      console.log(chalk.yellow('⚠️  No test directories found in ./test_data/'));
      return;
    }

    let passedTests = 0;
    const totalTests = subdirs.length;

    for (const subdir of subdirs) {
      const testPath = path.join(testDir, subdir);
      const inFile = path.join(testPath, 'in.js');
      const outFile = path.join(testPath, 'out.js');

      if (!fs.existsSync(inFile)) {
        console.log(chalk.red.bold(`❌ Failed on test ${subdir}`));
        console.log(chalk.yellow(`Missing input file: ${inFile}\n`));
        continue;
      }

      if (!fs.existsSync(outFile)) {
        console.log(chalk.red.bold(`❌ Failed on test ${subdir}`));
        console.log(chalk.yellow(`Missing output file: ${outFile}\n`));
        continue;
      }

      try {
        const inputContent = fs.readFileSync(inFile, 'utf8');
        const expectedOutput = fs.readFileSync(outFile, 'utf8').trim();

        const actualOutput = execSync(`node ${mainScript} ${inFile}`, {
          encoding: 'utf8',
          timeout: 10000,
        }).trim();

        if (actualOutput === expectedOutput) {
          passedTests++;
          console.log(chalk.green.bold(`✅ Success on test ${subdir}`));
          console.log(chalk.dim('Input:'));
          console.log(chalk.gray('```'));
          console.log(chalk.dim(inputContent));
          console.log(chalk.gray('```'));
          console.log(chalk.dim('Result:'));
          console.log(chalk.gray('```'));
          console.log(chalk.green(actualOutput));
          console.log(chalk.gray('```\n'));
        } else {
          console.log(chalk.red.bold(`❌ Failed on test ${subdir}`));
          console.log(chalk.dim('Input:'));
          console.log(chalk.gray('```'));
          console.log(chalk.dim(inputContent));
          console.log(chalk.gray('```'));

          displayDiff(expectedOutput, actualOutput);

          console.log(chalk.dim('\n📋 Full outputs for reference:'));
          console.log(chalk.yellow('Expected:'));
          console.log(chalk.gray('```'));
          console.log(chalk.yellow(expectedOutput));
          console.log(chalk.gray('```'));
          console.log(chalk.red('Actual:'));
          console.log(chalk.gray('```'));
          console.log(chalk.red(actualOutput));
          console.log(chalk.gray('```\n'));
        }
      } catch (error) {
        console.log(chalk.red.bold(`❌ Failed on test ${subdir}`));
        console.log(chalk.dim('Input:'));
        console.log(chalk.gray('```'));
        const inputContent = fs.readFileSync(inFile, 'utf8');
        console.log(chalk.dim(inputContent));
        console.log(chalk.gray('```'));
        console.log(chalk.dim('Expected:'));
        console.log(chalk.gray('```'));
        const expectedOutput = fs.readFileSync(outFile, 'utf8');
        console.log(chalk.yellow(expectedOutput));
        console.log(chalk.gray('```'));
        console.log(chalk.red.bold('💥 Error:'));
        console.log(chalk.gray('```'));
        console.log(chalk.red(error.message));
        console.log(chalk.gray('```\n'));
      }
    }

    console.log('═'.repeat(60));
    const successRate = Math.round((passedTests / totalTests) * 100);
    const summaryColor =
      passedTests === totalTests
        ? chalk.green.bold
        : successRate >= 50
        ? chalk.yellow.bold
        : chalk.red.bold;

    console.log(summaryColor(`📊 Test Summary: ${passedTests}/${totalTests} passed (${successRate}%)`));
    console.log('═'.repeat(60));
  } catch (error) {
    console.error(chalk.red.bold('💥 Error reading test directory:'), chalk.red(error.message));
    process.exit(1);
  }
}

runTests();
