import { assertSafeTestDatabaseUrl } from "./database-guard";

export const TEST_BOOTSTRAP_TOKEN = "integration-test-bootstrap-token-0123456789";

// The guard runs before anything else, and application code is pointed at the
// vetted test database only. DATABASE_URL from the shell is overwritten.
const testUrl = assertSafeTestDatabaseUrl(process.env);
process.env.TEST_DATABASE_URL = testUrl;
process.env.DATABASE_URL = testUrl;
process.env.DATABASE_POOL_SIZE = "10";
process.env.BOOTSTRAP_ADMIN_TOKEN = TEST_BOOTSTRAP_TOKEN;
