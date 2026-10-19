// Cria um administrador da plataforma: npm run admin:create -- email senha "Nome"
import { createAdmin } from './auth.js';

const [email, password, name = 'Administrador'] = process.argv.slice(2);
if (!email || !password) {
  console.log('Uso: npm run admin:create -- email@exemplo.com SenhaForte123 "Seu Nome"');
  process.exit(1);
}
try {
  createAdmin({ name, email, password });
  console.log(`Administrador criado. Acesse /admin com ${email}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
