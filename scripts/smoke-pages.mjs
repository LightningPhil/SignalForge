const baseUrl = new URL(process.argv[2] || 'https://lightningphil.github.io/SignalForge/');
baseUrl.searchParams.set('smoke', Date.now().toString());

async function requireResponse(url, expectedType) {
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache' },
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes(expectedType)) {
    throw new Error(`Expected ${expectedType}, received ${contentType || 'no content type'}: ${url}`);
  }
  return response;
}

const htmlResponse = await requireResponse(baseUrl, 'text/html');
const html = await htmlResponse.text();
const scriptMatch = html.match(/<script[^>]+src=["']([^"']+)["']/i);
const styleMatch = html.match(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/i);

if (!scriptMatch || !styleMatch) {
  throw new Error('Built page does not reference both a JavaScript entry and a stylesheet.');
}

const scriptUrl = new URL(scriptMatch[1], baseUrl);
const styleUrl = new URL(styleMatch[1], baseUrl);
await Promise.all([requireResponse(scriptUrl, 'javascript'), requireResponse(styleUrl, 'text/css')]);

console.log(`Pages smoke check passed: ${baseUrl.origin}${baseUrl.pathname}`);
console.log(`JavaScript: ${scriptUrl.pathname}`);
console.log(`Stylesheet: ${styleUrl.pathname}`);
