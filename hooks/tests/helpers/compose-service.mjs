/**
 * One service's block of a compose file, as text: from `  <name>:` under
 * `services:` to the next service or top-level key. Enough for tests that
 * check what a service mounts and holds; not a YAML parser.
 */
export function composeService(compose, name) {
  const lines = compose.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`compose has no service ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).filter((line) => !/^\s*#/.test(line)).join('\n');
}
