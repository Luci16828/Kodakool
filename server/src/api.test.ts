import { openMemoryDb } from "./db-node.ts";
import { runApiSuite } from "./api.suite.ts";

runApiSuite(() => openMemoryDb());
