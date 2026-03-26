import express from 'express';
import type { Router } from 'express';

export function createJsonApp(router: Router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}
