require('dotenv').config(); // Carga las variables de entorno
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const jwt = require('jsonwebtoken');
const app = express();
const PORT = process.env.PORT || 3001;
const bcrypt = require('bcryptjs');

// --- MIDDLEWARES ---
// Permite que otras aplicaciones (tu web y app) se conecten
app.use(cors()); 
// Permite que el servidor entienda la inf  ormación que llega en formato JSON
app.use(express.json()); 

// --- RUTAS DE PRUEBA ---
app.get('/', (req, res) => {
  res.send('API de Páscolo funcionando');
});

app.get('/api/test-db', async (req, res) => {
  try {
    // Le pedimos a PostgreSQL que nos devuelva la hora actual del servidor
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      mensaje: "¡Conexión a PostgreSQL funcionando 10 puntos!", 
      hora_servidor: result.rows[0].now 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fallo la conexión a la base de datos" });
  }
});
// --- RUTAS DE LA APP MÓVIL ---

// Ruta de Login para operarios
app.post('/api/login', async (req, res) => {
  // Nota: En el frontend enviamos { pin: pin }, por eso extraemos 'pin'
  const pinRecibido = req.body.pin;

  // Validación rápida de seguridad
  if (!pinRecibido || pinRecibido.length !== 4) {
    return res.status(400).json({ error: "El PIN debe tener 4 dígitos" });
  }

  try {
    // Buscamos directamente por el PIN. Al ser UNIQUE, devuelve 1 o 0 resultados.
    // Solo traemos los datos que la app necesita (id, nombre, rol), no traemos el password viejo.
    const resultado = await pool.query(
      'SELECT id, nombre, rol FROM usuarios WHERE pin = $1',
      [pinRecibido]
    );

    // Si no encuentra a nadie con ese PIN, rebota la conexión
    if (resultado.rows.length === 0) {
      return res.status(401).json({ error: "PIN incorrecto o no registrado" });
    }

    const operario = resultado.rows[0];

    // ¡Ingreso exitoso! Le damos luz verde a la app
    const token = jwt.sign(
    { id: operario.id, nombre: operario.nombre, rol: operario.rol },
    process.env.JWT_SECRET || 'PASCOLOTAMBO2824',
    { expiresIn: '12h' } // Aquí definimos el límite de 12 horas
);

res.json({ token, usuario: operario });

  } catch (error) {
    console.error("Error en el login por PIN:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST: Recibe un lote completo desde la App y lo guarda en la BD
app.post('/api/lotes/completo', async (req, res) => {
  const { codigo_lote, usuario_id, items } = req.body;

  // Validación básica
  if (!usuario_id || !items || items.length === 0) {
    return res.status(400).json({ error: "Datos incompletos. Faltan ítems o usuario." });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Iniciamos la transacción

    // 1. Creamos el "Envase" del Lote (Padre)
    const resLote = await client.query(
      `INSERT INTO lotes_produccion (codigo_lote, creado_por) 
       VALUES ($1, $2) RETURNING id`,
      [codigo_lote, usuario_id]
    );
    const loteId = resLote.rows[0].id;

    // 2. Procesamos cada queso que salió de la tina
    for (let item of items) {
      // A. Guardamos la trazabilidad (Lo que se fabricó)
      // Nota: Si desde la app aún no mandan peso_fresco_kg, entra como NULL
      const resItem = await client.query(
        `INSERT INTO lote_items (lote_id, presentacion_id, cantidad_unidades, peso_fresco_kg) 
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [loteId, item.presentacion_id, item.cantidad, item.peso_fresco_kg || null]
      );
      const loteItemId = resItem.rows[0].id;

      // B. EL ESLABÓN PERDIDO: Ingresamos las unidades reales a la cámara de frío
      // Nacen con 0 días de maduración
      await client.query(
        `INSERT INTO stock_fisico (lote_item_id, dias_maduracion, cantidad_unidades_disponibles) 
         VALUES ($1, 0, $2)`,
        [loteItemId, item.cantidad]
      );
    }

    await client.query('COMMIT'); // Todo salió bien, guardamos de forma permanente
    res.status(201).json({ 
      mensaje: "Lote creado con éxito. Stock físico ingresado a la cámara.", 
      lote_id: loteId 
    });

  } catch (error) {
    await client.query('ROLLBACK'); // Si explota algo, no guardamos datos a medias
    console.error("Error al guardar el lote y el stock:", error);
    res.status(500).json({ error: "No se pudo guardar la producción en la base de datos." });
  } finally {
    client.release();
  }
});

// 1. Obtener todos los productos con sus presentaciones
app.get('/api/productos-completo', async (req, res) => {
  try {
    const query = `
      SELECT p.id as producto_id, p.nombre, pr.id as presentacion_id, pr.formato
      FROM productos p
      JOIN presentaciones pr ON p.id = pr.producto_id
      ORDER BY p.nombre, pr.formato
    `;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

// 2. Obtener info del usuario actual (basado en el token o ID)
app.get('/api/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query('SELECT id, nombre, rol FROM usuarios WHERE id = $1', [id]);
    res.json(resultado.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener usuario" });
  }
});

// 3. Generar el código de lote sugerido (L-AAMMDD)
app.get('/api/lotes/sugerir-codigo', async (req, res) => {
  const hoy = new Date();
  const fecha = hoy.toISOString().slice(2, 10).replace(/-/g, '');

  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM lotes_produccion WHERE codigo_lote LIKE $1`,
      [`L-${fecha}%`]
    );

    const numero = parseInt(result.rows[0].count, 10) + 1;

    const codigo = `L-${fecha}-${numero.toString().padStart(2, '0')}`;

    res.json({ codigo });
  } catch (error) {
    res.status(500).json({ error: 'Error generando código de lote' });
  }
});

// ==========================================
// GET: Obtener lista de Pedidos para la App
// ==========================================
app.get('/api/pedidos', async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id, 
        p.cliente_nombre, 
        p.estado, 
        p.fecha_creacion,
        (SELECT monto_total FROM pagos pg WHERE pg.pedido_id = p.id ORDER BY pg.fecha_creacion DESC LIMIT 1) as monto_total,
        (SELECT referencia_externa FROM pagos pg WHERE pg.pedido_id = p.id ORDER BY pg.fecha_creacion DESC LIMIT 1) as referencia_externa,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'prod', pr.nombre,
              'formato', pres.formato,
              'cant', pi.cantidad_pedida,
              'mad', pi.maduracion_deseada
            ))
            FROM pedido_items pi
            JOIN presentaciones pres ON pi.presentacion_id = pres.id
            JOIN productos pr ON pres.producto_id = pr.id
            WHERE pi.pedido_id = p.id
          ), '[]'::json
        ) as items
      FROM pedidos p
      ORDER BY 
        CASE WHEN p.estado = 'pendiente' THEN 1 ELSE 2 END, 
        p.fecha_creacion DESC;
    `;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (err) {
    console.error("Error al obtener pedidos:", err);
    res.status(500).json({ error: "Error al obtener pedidos" });
  }
});

// ==========================================
// POST: Marcar Pedido como "Listo" y descontar Stock
// ==========================================
app.post('/api/pedidos/:id/listo', async (req, res) => {
  const { id } = req.params;
  const { usuario_id } = req.body;

  if (!usuario_id) {
    return res.status(400).json({ error: "Falta el ID del operario" });
  }

  const client = await pool.connect();

  const checkEstado = await client.query("SELECT estado FROM pedidos WHERE id = $1", [id]);
  if (checkEstado.rows[0].estado !== 'pendiente') {
    throw new Error("Este pedido ya fue despachado o no está pendiente.");
  }
  
  try {
    await client.query('BEGIN');

    await client.query("UPDATE pedidos SET estado = 'listo' WHERE id = $1", [id]);

    // Traemos los items, incluyendo el texto de maduración
    const itemsRes = await client.query('SELECT id, presentacion_id, cantidad_pedida, maduracion_deseada FROM pedido_items WHERE pedido_id = $1', [id]);

    for (let item of itemsRes.rows) {
      let cantidadRestante = item.cantidad_pedida;

      // 1. TRADUCTOR: Extraemos el número del texto (ej: "30 días" -> 30, "Fresco" -> 0)
      let diasBuscados = 0;
      if (item.maduracion_deseada) {
        const matchNumerico = item.maduracion_deseada.match(/\d+/);
        if (matchNumerico) {
          diasBuscados = parseInt(matchNumerico[0], 10);
        }
      }

      // 2. BUSCADOR ESTRICTO: Exigimos que cruce presentación Y los días exactos
      const stockRes = await client.query(`
        SELECT sf.id, sf.cantidad_unidades_disponibles
        FROM stock_fisico sf
        JOIN lote_items li ON sf.lote_item_id = li.id
        WHERE li.presentacion_id = $1 
          AND sf.dias_maduracion = $2   -- <- ¡La nueva regla de oro!
          AND sf.cantidad_unidades_disponibles > 0
        ORDER BY sf.fecha_ultimo_control ASC
      `, [item.presentacion_id, diasBuscados]);

      for (let stock of stockRes.rows) {
        if (cantidadRestante <= 0) break;

        const aDescontar = Math.min(cantidadRestante, stock.cantidad_unidades_disponibles);

        await client.query(`
          UPDATE stock_fisico 
          SET cantidad_unidades_disponibles = cantidad_unidades_disponibles - $1 
          WHERE id = $2
        `, [aDescontar, stock.id]);

        await client.query(`
          INSERT INTO ventas (pedido_item_id, stock_fisico_id, cantidad_unidades_descontadas, operario_id)
          VALUES ($1, $2, $3, $4)
        `, [item.id, stock.id, aDescontar, usuario_id]);

        cantidadRestante -= aDescontar;
      }

      // 3. MENSAJE DE ERROR CLARO
      if (cantidadRestante > 0) {
        throw new Error(`Stock insuficiente: Faltan ${cantidadRestante} unidades de formato ID ${item.presentacion_id} con maduración de ${diasBuscados} días.`);
      }
    }

    await client.query('COMMIT');
    res.json({ mensaje: "Pedido preparado y stock descontado correctamente." });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error al despachar pedido:", err);
    res.status(400).json({ error: err.message || "Error al procesar la salida de stock" });
  } finally {
    client.release();
  }
});

// POST: Registrar ordeñe diario
app.post('/api/produccion-leche', async (req, res) => {
  const { litros, usuario_id, observaciones, fecha } = req.body;
  try {
    const query = `
      INSERT INTO produccion_leche (litros, usuario_id, observaciones, fecha)
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE))
      RETURNING *;
    `;
    const resultado = await pool.query(query, [litros, usuario_id, observaciones, fecha]);
    res.status(201).json(resultado.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar la producción de leche" });
  }
});

// GET: Ver historial de producción de leche (últimos 30 días)
app.get('/api/produccion-leche', async (req, res) => {
  try {
    const query = `
      SELECT pl.*, u.nombre as operario
      FROM produccion_leche pl
      JOIN usuarios u ON pl.usuario_id = u.id
      ORDER BY pl.fecha DESC
      LIMIT 30;
    `;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener historial de leche" });
  }
});

app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error("Error al buscar productos:", err);
        res.status(500).json({ error: "Error del servidor" });
    }
});

app.get('/api/productos/:id', async (req, res) => {
    const { id } = req.get;
    try {
        // 1. Traemos los datos básicos del producto
        const productoRes = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
        
        if (productoRes.rows.length === 0) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }

        // 2. Traemos sus formatos (presentaciones) calculando el stock físico disponible real
        const formatosRes = await pool.query(`
            SELECT 
                pres.id,
                pres.formato,
                pres.peso_estimado_kg,
                COALESCE(SUM(sf.cantidad_unidades_disponibles), 0) AS stock_disponible
            FROM presentaciones pres
            LEFT JOIN lote_items li ON pres.id = li.presentacion_id
            LEFT JOIN stock_fisico sf ON li.id = sf.lote_item_id
            WHERE pres.producto_id = $1
            GROUP BY pres.id, pres.formato, pres.peso_estimado_kg
            ORDER BY pres.id
        `, [id]);

        const producto = productoRes.rows[0];
        producto.formatos = formatosRes.rows;

        res.json(producto);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al obtener el detalle del producto" });
    }
});

// 1. ENDPOINT DE LOGIN
app.post('/api/admin/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
        const user = result.rows[0];

        if (!user) return res.status(401).json({ error: "Usuario no encontrado" });

        // Comparamos la clave ingresada con el hash de la base de datos
        const passwordCorrecto = await bcrypt.compare(password, user.password_hash);
        if (!passwordCorrecto) return res.status(401).json({ error: "Contraseña incorrecta" });

        // Si todo está bien, firmamos el token (JWT)
        const token = jwt.sign(
            { id: user.id, rol: user.rol }, 
            process.env.JWT_SECRET || 'clave_secreta_pascolo', 
            { expiresIn: '12h' }
        );

        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// 2. MIDDLEWARE DE PROTECCIÓN (El Guardián)
const validarToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(403).json({ error: "Acceso denegado" });

    try {
        const verificado = jwt.verify(token, process.env.JWT_SECRET || 'clave_secreta_pascolo');
        req.user = verificado;
        next(); // Permite pasar a la siguiente función
    } catch (err) {
        res.status(401).json({ error: "Token inválido o expirado" });
    }
};

// DELETE: Eliminar un lote de leche
app.delete('/api/leche/lotes/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        // Opcional: Podrías hacer una validación de seguridad extra acá
        // para asegurarte de que el usuario que lo pide sea admin.
        
        const result = await pool.query('DELETE FROM produccion_leche WHERE id = $1 RETURNING *', [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Lote no encontrado' });
        }
        
        res.json({ mensaje: 'Lote eliminado correctamente', loteBorrado: result.rows[0] });
    } catch (err) {
        console.error("Error al borrar lote de leche:", err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET: Historial de lotes de queso (Últimos 7 días)
app.get('/api/quesos/historial-reciente', async (req, res) => {
    try {
        // Traemos los lotes ordenados desde el más nuevo al más viejo
        // Usamos INTERVAL '7 days' de PostgreSQL para filtrar automáticamente
        const result = await pool.query(`
            SELECT 
                lp.id, 
                lp.codigo_lote, 
                lp.fecha_elaboracion,
                u.nombre AS operario
            FROM lotes_produccion lp
            LEFT JOIN usuarios u ON lp.creado_por = u.id
            WHERE lp.fecha_elaboracion >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY lp.fecha_elaboracion DESC
        `);
        
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener historial de quesos:", err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
  console.log(`Servidor de Páscolo corriendo en http://localhost:${PORT}`);
});