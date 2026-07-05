exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = event.headers['x-api-key'];
  if (!apiKey) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing API key' }) };
  }

  try {
    const body = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    // Forward retry-after so the browser knows how long to wait on 429/529
    const retryAfter = response.headers.get('retry-after');
    const outHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    };
    if (retryAfter) {
      outHeaders['retry-after'] = retryAfter;
    }

    return {
      statusCode: response.status,
      headers: outHeaders,
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
