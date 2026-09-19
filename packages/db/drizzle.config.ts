import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema/app.ts", "./src/schema/idx.ts", "./src/schema/activity.ts"],
  out: "./drizzle",
  schemaFilter: ["app", "idx"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/fdrive",
  },
});
