const fs = require('fs');
const readline = require('readline');

const logPath = 'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\6ec246cd-eda0-4d8e-aaf1-665587627d9e\\.system_generated\\logs\\transcript_full.jsonl';
const outputPath = 'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\6ec246cd-eda0-4d8e-aaf1-665587627d9e\\scratch\\old_worker_code.txt';

const rl = readline.createInterface({
  input: fs.createReadStream(logPath),
  output: process.stdout,
  terminal: false
});

let lineNum = 0;
let outputContent = '';

rl.on('line', (line) => {
  lineNum++;
  if (lineNum === 475 || lineNum === 476 || lineNum === 493 || lineNum === 494) {
    try {
      const obj = JSON.parse(line);
      outputContent += `=== LINE ${lineNum} (Type: ${obj.type}) ===\n`;
      outputContent += obj.content + '\n\n';
    } catch (e) {
      outputContent += `=== LINE ${lineNum} (Raw) ===\n${line}\n\n`;
    }
  }
});

rl.on('close', () => {
  fs.writeFileSync(outputPath, outputContent);
  console.log('Success! Wrote matched lines to old_worker_code.txt');
});
