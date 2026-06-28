import 'dotenv/config';
import { program } from './cli';

await program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});