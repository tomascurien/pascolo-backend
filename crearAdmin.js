const bcrypt = require('bcryptjs');

const crearHash = async (password) => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    console.log("Tu nueva contraseña encriptada es:", hash);
};

crearHash("TuClaveSegura2024"); // Cambia esto por la clave que quieras