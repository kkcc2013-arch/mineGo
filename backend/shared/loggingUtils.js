'use strict';
const {format} = require('node:util');

function redactObject(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const result = new Map(); seen.set(value,result);
    for (const [key,item] of Map.prototype.entries.call(value)) result.set(key,
      /^(password|token|authorization|cookie|accessToken|refreshToken|apiKey|clientSecret)$/i.test(String(key)) ? '[REDACTED]' : redactObject(item,seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set(); seen.set(value,result);
    for (const item of Set.prototype.values.call(value)) result.add(redactObject(item,seen));
    return result;
  }
  const result = value instanceof Error ? new Error() : Array.isArray(value) ? [] : {};
  if (value instanceof Error) Object.setPrototypeOf(result, Object.getPrototypeOf(value));
  seen.set(value, result);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable && !(value instanceof Error && ['message','stack','cause'].includes(key))) continue;
    const content = /^(password|token|authorization|cookie|accessToken|refreshToken|apiKey|clientSecret)$/i.test(key)
      ? '[REDACTED]' : 'value' in descriptor ? redactObject(descriptor.value, seen) : '[Getter]';
    Object.defineProperty(result, key, {value:content, enumerable:descriptor.enumerable, writable:true, configurable:true});
  }
  return result;
}

class ConsoleMigrationHelper {
  constructor(logger, moduleName) {
    this.logger = logger;
    this.moduleName = moduleName;
  }
  write(level, args, stack) {
    if (typeof this.logger.isLevelEnabled === 'function' && !this.logger.isLevelEnabled(level)) return;
    if (args.length === 1 && typeof args[0] === 'string' && !stack) {
      this.logger[level]({module:this.moduleName,migration:true},args[0]); return;
    }
    args = args.map(value => redactObject(value));
    const error = args.find(value => value instanceof Error);
    const data = args.filter(value => value !== null && typeof value === 'object' && !(value instanceof Error));
    const details = {module: this.moduleName, migration: true};
    if (error) details.err = error;
    if (data.length) details.data = data;
    if (stack) details.stack = stack;
    this.logger[level](details, format(...args));
  }
  log(...args) { this.write('info', args); }
  info(...args) { this.write('info', args); }
  warn(...args) { this.write('warn', args); }
  error(...args) { this.write('error', args); }
  debug(...args) { this.write('debug', args); }
  trace(...args) { this.write('trace', args, new Error('Log call site').stack); }
}

// Opt-in only; importing this module never patches the global console.
function replaceConsole(logger, moduleName) {
  const original = global.console;
  const helper = new ConsoleMigrationHelper(logger, moduleName);
  const replacement = Object.create(original);
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) replacement[method] = helper[method].bind(helper);
  global.console = replacement;
  return () => { if (global.console === replacement) global.console = original; };
}
module.exports = {ConsoleMigrationHelper, replaceConsole};
