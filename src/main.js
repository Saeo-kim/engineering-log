import { createApp } from './server.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const app = await createApp({
  databaseFile: process.env.DATABASE_FILE || './data/engineering-log.db',
  username: process.env.APP_USERNAME,
  password: process.env.APP_PASSWORD,
  cookieSecure: process.env.COOKIE_SECURE === 'true' ? true : process.env.COOKIE_SECURE === 'false' ? false : 'auto',
  trustProxy: process.env.TRUST_PROXY === '1',
});

app.server.listen(port, host, () => {
  console.log(`Engineering Log listening on http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close();
    process.exit(0);
  });
}
