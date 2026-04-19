export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    // GET /api/recipes — load all recipes
    if (path === '/api/recipes' && request.method === 'GET') {
      const data = await env.RECIPES_KV.get('recipes');
      return new Response(data || '[]', { headers });
    }

    // POST /api/recipes — save all recipes
    if (path === '/api/recipes' && request.method === 'POST') {
      const body = await request.text();
      await env.RECIPES_KV.put('recipes', body);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    // POST /api/scrape — scrape a recipe URL
    if (path === '/api/scrape' && request.method === 'POST') {
      const { url: recipeUrl } = await request.json();
      if (!recipeUrl) return new Response(JSON.stringify({ error: 'No URL provided' }), { status: 400, headers });

      const res = await fetch(recipeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });

      if (!res.ok) return new Response(JSON.stringify({ error: `Could not fetch page (${res.status})` }), { status: 400, headers });

      const html = await res.text();
      const recipe = extractRecipe(html, recipeUrl);

      if (!recipe) return new Response(JSON.stringify({ error: 'No recipe data found on this page' }), { status: 404, headers });

      return new Response(JSON.stringify(recipe), { headers });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Server error' }), { status: 500, headers });
  }
}

function extractRecipe(html, sourceUrl) {
  // Extract all JSON-LD blocks
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const match of jsonLdMatches) {
    try {
      let data = JSON.parse(match[1].trim());

      // Handle arrays and @graph
      if (Array.isArray(data)) {
        data = data.find(d => isRecipe(d)) || data[0];
      }
      if (data?.['@graph']) {
        data = data['@graph'].find(d => isRecipe(d)) || data;
      }

      if (!isRecipe(data)) continue;

      return parseRecipeData(data, sourceUrl);
    } catch (e) { continue; }
  }
  return null;
}

function isRecipe(d) {
  if (!d) return false;
  const type = d['@type'];
  if (typeof type === 'string') return type === 'Recipe';
  if (Array.isArray(type)) return type.includes('Recipe');
  return false;
}

function parseRecipeData(data, sourceUrl) {
  const ingredients = (data.recipeIngredient || []).map(parseIngredient);

  const rawSteps = data.recipeInstructions || [];
  let steps = [];
  if (typeof rawSteps === 'string') {
    steps = rawSteps.split('\n').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(rawSteps)) {
    steps = rawSteps.flatMap(s => {
      if (typeof s === 'string') return [s.trim()];
      if (s['@type'] === 'HowToSection') return (s.itemListElement || []).map(i => (i.text || i.name || '').trim());
      return [(s.text || s.name || '').trim()];
    }).filter(Boolean);
  }

  const servings = data.recipeYield;
  const srvNum = typeof servings === 'number' ? servings
    : typeof servings === 'string' ? (parseInt(servings.match(/\d+/)?.[0]) || 4)
    : Array.isArray(servings) ? (parseInt(servings[0]) || 4) : 4;

  const cuisine = [data.recipeCuisine, data.recipeCategory]
    .flat().filter(Boolean).map(s => s.toString())[0] || '';

  return {
    title: (data.name || '').trim(),
    cuisine,
    description: (typeof data.description === 'string' ? data.description : '').replace(/<[^>]+>/g, '').trim(),
    servings: srvNum,
    prepTime: parseDuration(data.prepTime),
    cookTime: parseDuration(data.cookTime || data.totalTime),
    ingredients,
    steps,
    source: sourceUrl,
    image: data.image?.url || (Array.isArray(data.image) ? data.image[0]?.url : data.image) || '',
  };
}

function parseDuration(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0), min = parseInt(m[2] || 0);
  if (h && min) return `${h}h ${min} min`;
  if (h) return `${h} hr`;
  if (min) return `${min} min`;
  return '';
}

function parseIngredient(str) {
  str = str.trim();
  // Unicode fractions
  const fracs = { '¼': '0.25', '½': '0.5', '¾': '0.75', '⅓': '0.333', '⅔': '0.667', '⅛': '0.125', '⅜': '0.375', '⅝': '0.625', '⅞': '0.875' };
  let s = str;
  for (const [ch, val] of Object.entries(fracs)) s = s.replace(new RegExp(ch, 'g'), val);

  const m = s.match(/^([\d\s\/\.]+)\s*([a-zA-Z]+\.?)?\s+(.+)$/);
  if (!m) return { amount: 0, unit: '', name: str };

  let amt = 0;
  const parts = m[1].trim().split(/\s+/);
  for (const p of parts) {
    if (p.includes('/')) { const [a, b] = p.split('/'); amt += parseFloat(a) / parseFloat(b); }
    else amt += parseFloat(p) || 0;
  }

  return { amount: parseFloat(amt.toFixed(4)), unit: (m[2] || '').trim(), name: m[3].trim() };
}
