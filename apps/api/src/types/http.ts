export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRouteDef {
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  auth: 'public' | 'bearer';
}

export function buildRouteManifest(routes: HttpRouteDef[]): Record<string, HttpRouteDef[]> {
  return routes.reduce<Record<string, HttpRouteDef[]>>((acc, route) => {
    const bucket = acc[route.tag] ?? [];
    bucket.push(route);
    acc[route.tag] = bucket;
    return acc;
  }, {});
}
