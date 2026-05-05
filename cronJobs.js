
const cron = require('node-cron');
const pool = require('./db'); // Tu conexión a PostgreSQL

// Corre todos los días a las 03:00 AM
const iniciarCronJobs = () => {
    // Se ejecuta todos los días a las 03:00 AM
    cron.schedule('0 3 * * *', async () => {
        console.log("[CRON] Iniciando revisión de maduración de quesos...");
        try {
            const query = `
                UPDATE stock_fisico sf
                SET dias_maduracion = sf.dias_maduracion + 30
                FROM lote_items li
                JOIN lotes_produccion lp ON li.lote_id = lp.id
                WHERE sf.lote_item_id = li.id
                AND (CURRENT_DATE - lp.fecha_elaboracion) >= (sf.dias_maduracion + 30);
            `;
            
            const result = await pool.query(query);
            console.log(`[CRON] Revisión terminada. Lotes actualizados: ${result.rowCount}`);
        } catch (error) {
            console.error("[CRON] Error actualizando maduración:", error);
        }
    });
    console.log("Cron jobs configurados y listos.");
};

module.exports = iniciarCronJobs;