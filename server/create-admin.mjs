import { createInterface } from 'node:readline/promises';
import { database, createUser } from './database.mjs';
const prompt = createInterface({ input: process.stdin, output: process.stdout });
const db = database();
try {
  const name = await prompt.question('Administrator name: ');
  const email = await prompt.question('Email: ');
  // Read from the terminal without echoing a password into logs or shell history.
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
  prompt.close();
  process.stdout.write('Password (at least 6 characters; hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const password = await new Promise((resolve, reject) => {
    let value = '';
    function read(chunk) {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    function cleanup() { process.stdin.off('data', read); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
    process.stdin.on('data', read);
  });
  const user = createUser(db, { name, email, password, role: 'admin' });
  console.log(`Administrator created: ${user.email}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { prompt.close(); db.close(); }
