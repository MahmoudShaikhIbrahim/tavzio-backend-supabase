const https = require('https');

// Every language code the app supports on the customer-facing side.
const ALL_LANGUAGES = ['en', 'ar', 'ru', 'es', 'hi', 'ur', 'tl', 'zh', 'fr'];

function callGoogleTranslate(text, targetLang) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!apiKey) return reject(new Error('GOOGLE_TRANSLATE_API_KEY is not set'));

    const body = JSON.stringify({ q: text, target: targetLang, format: 'text' });
    const req = https.request(
      {
        hostname: 'translation.googleapis.com',
        path: `/language/translate/v2?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.data.translations[0].translatedText);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Translates one piece of text into every supported language, returning a
// {en: '...', ar: '...', ...} object ready to store directly in a
// *_i18n jsonb column. Google auto-detects whatever language the owner
// actually typed in - we don't need to know or ask.
async function translateToAllLanguages(text) {
  if (!text || !text.trim()) return {};

  const results = {};
  await Promise.all(
    ALL_LANGUAGES.map(async (lang) => {
      try {
        results[lang] = await callGoogleTranslate(text, lang);
      } catch (err) {
        // A single language failing (rate limit, transient network issue)
        // should never block saving the owner's actual content - the
        // fallback to the original text elsewhere covers this gracefully.
        console.error(`Translation to ${lang} failed:`, err.message);
      }
    })
  );
  return results;
}

// Picks the translated version for a given language, falling back to the
// original text if that language's translation is missing for any reason
// (translation failed, content was saved before this feature existed, or
// the requested language just isn't in the object).
function resolveText(original, i18n, lang) {
  return (i18n && i18n[lang]) || original || '';
}

module.exports = { translateToAllLanguages, resolveText, ALL_LANGUAGES };
