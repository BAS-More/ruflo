/**
 * @claude-flow/mcp - JSON Schema Validator
 *
 * Lightweight JSON Schema validation for tool inputs
 * Implements JSON Schema Draft 2020-12 subset
 *
 * Resource-bounded: validation of untrusted input is capped by array length,
 * property count, total values visited, recursion depth and number of
 * collected errors.
 */

import type { JSONSchema } from './types.js';

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** True when maxErrors was reached, so further errors may have been omitted */
  truncated?: boolean;
  /** True when validation stopped early on the maxDepth or maxNodes limit */
  limitHit?: boolean;
}

/**
 * Resource limits applied while validating untrusted input
 */
export interface ValidationLimits {
  /** Stop collecting after this many errors */
  maxErrors: number;
  /** Hard cap on array length, applied even when the schema omits maxItems */
  maxArrayItems: number;
  /** Hard cap on own property count, applied even when the schema omits maxProperties */
  maxProperties: number;
  /** Hard cap on total values visited in one validation */
  maxNodes: number;
  /** Hard cap on recursion depth */
  maxDepth: number;
}

export const DEFAULT_VALIDATION_LIMITS: Readonly<ValidationLimits> = Object.freeze({
  maxErrors: 20,
  maxArrayItems: 10_000,
  maxProperties: 10_000,
  maxNodes: 100_000,
  maxDepth: 32,
});

/** Max characters of attacker-influenced text (paths, property names) kept in an error */
const MAX_ERROR_TEXT = 200;

interface ValidationState {
  errors: ValidationError[];
  limits: ValidationLimits;
  nodes: number;
  /** Stop walking: maxErrors reached or a resource limit hit */
  stopped: boolean;
  truncated: boolean;
  limitHit: boolean;
  regexCache: Map<string, RegExp>;
}

/**
 * Validate data against JSON Schema
 */
export function validateSchema(
  data: unknown,
  schema: JSONSchema,
  path: string = '',
  limits: Partial<ValidationLimits> = {}
): ValidationResult {
  const state: ValidationState = {
    errors: [],
    limits: { ...DEFAULT_VALIDATION_LIMITS, ...limits },
    nodes: 0,
    stopped: false,
    truncated: false,
    limitHit: false,
    regexCache: new Map(),
  };

  validateNode(data, schema, path, 0, state);

  const result: ValidationResult = { valid: state.errors.length === 0, errors: state.errors };
  if (state.truncated) {
    result.truncated = true;
  }
  if (state.limitHit) {
    result.limitHit = true;
  }
  return result;
}

function clip(text: string): string {
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}...` : text;
}

/**
 * Record an error; once maxErrors is reached, validation stops
 */
function addError(state: ValidationState, error: ValidationError): void {
  if (state.stopped) return;
  error.path = clip(error.path);
  state.errors.push(error);
  if (state.errors.length >= state.limits.maxErrors) {
    state.truncated = true;
    state.stopped = true;
  }
}

/**
 * Record a resource-limit violation and stop validation immediately
 */
function abort(state: ValidationState, error: ValidationError): void {
  addError(state, error);
  state.limitHit = true;
  state.stopped = true;
}

function getRegex(state: ValidationState, pattern: string): RegExp {
  let regex = state.regexCache.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern);
    state.regexCache.set(pattern, regex);
  }
  return regex;
}

function validateNode(
  data: unknown,
  schema: JSONSchema,
  path: string,
  depth: number,
  state: ValidationState
): void {
  if (state.stopped) return;

  // Resource guards
  if (depth > state.limits.maxDepth) {
    abort(state, {
      path: path || 'root',
      message: `Maximum nesting depth of ${state.limits.maxDepth} exceeded`,
      keyword: 'maxDepth',
      params: { limit: state.limits.maxDepth },
    });
    return;
  }
  if (++state.nodes > state.limits.maxNodes) {
    abort(state, {
      path: path || 'root',
      message: `Input exceeds ${state.limits.maxNodes} values`,
      keyword: 'maxNodes',
      params: { limit: state.limits.maxNodes },
    });
    return;
  }

  // Type validation
  if (schema.type) {
    const typeValid = validateType(data, schema.type);
    if (!typeValid) {
      addError(state, {
        path: path || 'root',
        message: `Expected type "${schema.type}", got "${typeof data}"`,
        keyword: 'type',
        params: { expected: schema.type, actual: typeof data },
      });
      return;
    }
  }

  // Null check
  if (data === null || data === undefined) {
    if (schema.type && schema.type !== 'null') {
      addError(state, {
        path: path || 'root',
        message: 'Value cannot be null or undefined',
        keyword: 'type',
      });
    }
    return;
  }

  // String validations
  if (schema.type === 'string' && typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      addError(state, {
        path,
        message: `String length must be >= ${schema.minLength}`,
        keyword: 'minLength',
        params: { limit: schema.minLength, actual: data.length },
      });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      addError(state, {
        path,
        message: `String length must be <= ${schema.maxLength}`,
        keyword: 'maxLength',
        params: { limit: schema.maxLength, actual: data.length },
      });
      return; // do not run pattern/enum on an oversized string
    }
    if (schema.pattern && !getRegex(state, schema.pattern).test(data)) {
      addError(state, {
        path,
        message: `String must match pattern "${schema.pattern}"`,
        keyword: 'pattern',
        params: { pattern: schema.pattern },
      });
    }
    if (schema.enum && !schema.enum.includes(data)) {
      addError(state, {
        path,
        message: `Value must be one of: ${schema.enum.join(', ')}`,
        keyword: 'enum',
        params: { allowedValues: schema.enum },
      });
    }
  }

  // Number validations
  if ((schema.type === 'number' || schema.type === 'integer') && typeof data === 'number') {
    if (schema.type === 'integer' && !Number.isInteger(data)) {
      addError(state, {
        path,
        message: 'Value must be an integer',
        keyword: 'type',
      });
    }
    if (schema.minimum !== undefined && data < schema.minimum) {
      addError(state, {
        path,
        message: `Value must be >= ${schema.minimum}`,
        keyword: 'minimum',
        params: { limit: schema.minimum, actual: data },
      });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      addError(state, {
        path,
        message: `Value must be <= ${schema.maximum}`,
        keyword: 'maximum',
        params: { limit: schema.maximum, actual: data },
      });
    }
  }

  // Array validations (length is checked BEFORE any item is walked)
  if (schema.type === 'array' && Array.isArray(data)) {
    const maxItems = Math.min(schema.maxItems ?? Infinity, state.limits.maxArrayItems);
    if (data.length > maxItems) {
      addError(state, {
        path: path || 'root',
        message: `Array length must be <= ${maxItems}`,
        keyword: 'maxItems',
        params: { limit: maxItems, actual: data.length },
      });
      return;
    }
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      addError(state, {
        path: path || 'root',
        message: `Array length must be >= ${schema.minItems}`,
        keyword: 'minItems',
        params: { limit: schema.minItems, actual: data.length },
      });
    }
    if (schema.items) {
      for (let i = 0; i < data.length && !state.stopped; i++) {
        validateNode(data[i], schema.items, `${path}[${i}]`, depth + 1, state);
      }
    }
  }

  // Object validations
  if (schema.type === 'object' && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);

    const maxProperties = Math.min(schema.maxProperties ?? Infinity, state.limits.maxProperties);
    if (keys.length > maxProperties) {
      addError(state, {
        path: path || 'root',
        message: `Object must have <= ${maxProperties} properties`,
        keyword: 'maxProperties',
        params: { limit: maxProperties, actual: keys.length },
      });
      return;
    }

    // Required properties
    if (schema.required) {
      for (const requiredProp of schema.required) {
        if (state.stopped) return;
        if (!(requiredProp in obj)) {
          addError(state, {
            path: path ? `${path}.${requiredProp}` : requiredProp,
            message: `Required property "${requiredProp}" is missing`,
            keyword: 'required',
            params: { missingProperty: requiredProp },
          });
        }
      }
    }

    // Property validations
    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (state.stopped) return;
        if (propName in obj) {
          const propPath = path ? `${path}.${propName}` : propName;
          validateNode(obj[propName], propSchema, propPath, depth + 1, state);
        }
      }
    }

    // Additional properties check
    if (schema.additionalProperties === false && schema.properties) {
      const allowedProps = new Set(Object.keys(schema.properties));
      for (const propName of keys) {
        if (state.stopped) return;
        if (!allowedProps.has(propName)) {
          addError(state, {
            path: path ? `${path}.${propName}` : propName,
            message: `Additional property "${clip(propName)}" is not allowed`,
            keyword: 'additionalProperties',
            params: { additionalProperty: clip(propName) },
          });
        }
      }
    }
  }
}

/**
 * Validate type
 */
function validateType(data: unknown, expectedType: string): boolean {
  if (expectedType === 'null') {
    return data === null;
  }
  if (expectedType === 'array') {
    return Array.isArray(data);
  }
  if (expectedType === 'integer') {
    return typeof data === 'number' && Number.isInteger(data);
  }
  if (expectedType === 'object') {
    return typeof data === 'object' && data !== null && !Array.isArray(data);
  }
  return typeof data === expectedType;
}

/**
 * Format validation errors for display (bounded)
 */
export function formatValidationErrors(errors: ValidationError[], maxShown: number = 10): string {
  const shown = errors.slice(0, maxShown).map((e) => `${clip(e.path)}: ${e.message}`);
  if (errors.length > maxShown) {
    shown.push(`... and ${errors.length - maxShown} more`);
  }
  return shown.join('; ');
}

/**
 * Create a validator function for a specific schema
 */
export function createValidator(
  schema: JSONSchema,
  limits: Partial<ValidationLimits> = {}
): (data: unknown) => ValidationResult {
  return (data: unknown) => validateSchema(data, schema, '', limits);
}
