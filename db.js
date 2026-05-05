const { Pool } = require('pg');
require('dotenv').config();

// Creamos la conexión usando las variables del archivo .env
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

// Comprobamos si la conexión funciona
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error adquiriendo el cliente de la base de datos', err.stack);
  }
  console.log('Conexión exitosa a la base de datos PostgreSQL (pascolo_db)');
  release();
});

module.exports = pool;