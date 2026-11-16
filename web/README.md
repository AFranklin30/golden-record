# Golden Record web

Operator dashboard. It talks to the API with an httpOnly session cookie. It does not contain an organization API key.

```bash
cd web
npm install
npm test
npm run dev
```

The dev server proxies `/v1` to `http://localhost:3000`. Start the API separately.
