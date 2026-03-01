import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import $RefParser from '@apidevtools/json-schema-ref-parser';
import type { FastifySchema, HTTPMethods } from 'fastify';
import YAML from 'yaml';

import { AppError } from './errors.js';

type OpenApiMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

interface OpenApiParameter {
  in: ParameterLocation;
  name: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

interface OpenApiRequestBody {
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
}

interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiDocument {
  paths: Record<string, OpenApiPathItem>;
}

interface ParameterObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: boolean;
}

export interface OpenApiValidationProvider {
  getRouteSchema(method: HTTPMethods | string, openApiPath: string): FastifySchema;
  specPath: string;
}

interface OpenApiValidationOptions {
  specPath?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveDefaultSpecPath(): Promise<string> {
  const candidates = [
    process.env.OPENAPI_SPEC_PATH,
    path.resolve(process.cwd(), 'specs/api/openapi.yaml'),
    path.resolve(process.cwd(), '../specs/api/openapi.yaml'),
    path.resolve(process.cwd(), '../../specs/api/openapi.yaml')
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new AppError(500, 'OPENAPI_NOT_FOUND', 'Unable to locate OpenAPI spec file');
}

function normalizeMethod(method: HTTPMethods | string): OpenApiMethod {
  const normalized = method.toLowerCase();
  if (normalized === 'get' || normalized === 'post' || normalized === 'put' || normalized === 'patch' || normalized === 'delete') {
    return normalized;
  }
  throw new AppError(500, 'OPENAPI_METHOD_UNSUPPORTED', `Unsupported HTTP method for OpenAPI lookup: ${method}`);
}

function ensureObjectSchema(target: Record<string, unknown>, key: string, allowAdditional: boolean): ParameterObjectSchema {
  const existing = target[key];
  if (existing && typeof existing === 'object') {
    return existing as ParameterObjectSchema;
  }

  const created: ParameterObjectSchema = {
    type: 'object',
    properties: {},
    additionalProperties: allowAdditional
  };
  target[key] = created;
  return created;
}

function addRequiredProperty(schema: ParameterObjectSchema, propertyName: string): void {
  if (!schema.required) {
    schema.required = [];
  }
  if (!schema.required.includes(propertyName)) {
    schema.required.push(propertyName);
  }
}

function addParameterSchema(schema: Record<string, unknown>, parameter: OpenApiParameter): void {
  if (!parameter.schema) {
    return;
  }

  if (parameter.in === 'path') {
    const paramsSchema = ensureObjectSchema(schema, 'params', false);
    paramsSchema.properties[parameter.name] = parameter.schema;
    addRequiredProperty(paramsSchema, parameter.name);
    return;
  }

  if (parameter.in === 'query') {
    const querySchema = ensureObjectSchema(schema, 'querystring', false);
    querySchema.properties[parameter.name] = parameter.schema;
    if (parameter.required === true) {
      addRequiredProperty(querySchema, parameter.name);
    }
    return;
  }

  if (parameter.in === 'header') {
    const headersSchema = ensureObjectSchema(schema, 'headers', true);
    const headerName = parameter.name.toLowerCase();
    headersSchema.properties[headerName] = parameter.schema;
    if (parameter.required === true) {
      addRequiredProperty(headersSchema, headerName);
    }
  }
}

function extractRequestBodySchema(operation: OpenApiOperation): Record<string, unknown> | undefined {
  const content = operation.requestBody?.content;
  if (!content || typeof content !== 'object') {
    return undefined;
  }

  if (content['application/json']?.schema) {
    return content['application/json'].schema;
  }

  for (const [mediaType, mediaSchema] of Object.entries(content)) {
    if (mediaType.includes('json') && mediaSchema?.schema) {
      return mediaSchema.schema;
    }
  }

  return undefined;
}

function buildRouteSchemaFromOperation(pathItem: OpenApiPathItem, operation: OpenApiOperation): FastifySchema {
  const schema: Record<string, unknown> = {};
  const combinedParameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];

  for (const parameter of combinedParameters) {
    addParameterSchema(schema, parameter);
  }

  const bodySchema = extractRequestBodySchema(operation);
  if (bodySchema) {
    schema.body = bodySchema;
  }

  return schema as FastifySchema;
}

export async function createOpenApiValidationProvider(options: OpenApiValidationOptions = {}): Promise<OpenApiValidationProvider> {
  const specPath = options.specPath ?? (await resolveDefaultSpecPath());
  const raw = await readFile(specPath, 'utf8');
  const parsed = YAML.parse(raw) as object;
  const dereferenced = (await $RefParser.dereference(parsed)) as OpenApiDocument;

  if (!dereferenced.paths || typeof dereferenced.paths !== 'object') {
    throw new AppError(500, 'OPENAPI_INVALID', 'OpenAPI document does not contain valid paths');
  }

  const cache = new Map<string, FastifySchema>();

  return {
    specPath,
    getRouteSchema(method: HTTPMethods | string, openApiPath: string): FastifySchema {
      const normalizedMethod = normalizeMethod(method);
      const cacheKey = `${normalizedMethod}:${openApiPath}`;

      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const pathItem = dereferenced.paths[openApiPath];
      if (!pathItem) {
        throw new AppError(500, 'OPENAPI_OPERATION_NOT_FOUND', `Path not found in OpenAPI document: ${openApiPath}`);
      }

      const operation = pathItem[normalizedMethod];
      if (!operation) {
        throw new AppError(500, 'OPENAPI_OPERATION_NOT_FOUND', `Operation ${normalizedMethod.toUpperCase()} ${openApiPath} not found`);
      }

      const routeSchema = buildRouteSchemaFromOperation(pathItem, operation);
      cache.set(cacheKey, routeSchema);
      return routeSchema;
    }
  };
}
