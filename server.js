const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 80; // Puerto 80 para poder ingresar directo con "bibliotec5.com" sin escribir el puerto

// Configurar el almacenamiento físico de los archivos subidos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './archivos';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true }); // Crea la carpeta si no existe
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // Marca de tiempo para evitar que archivos con el mismo nombre se pisen
        cb(null, Date.now() + '_' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Abrir o crear de forma automática el archivo de la base de datos independiente
const db = new sqlite3.Database('./bibliotec.db', (err) => {
    if (err) console.error("Error al abrir SQLite:", err.message);
    else console.log("Base de datos independiente 'bibliotec.db' conectada con éxito.");
});

// Estructurar las tablas de la base de datos local
db.serialize(() => {
    // Tabla de profesores con la bandera requiere_cambio_clave (1 = Sí, 0 = No)
    db.run(`CREATE TABLE IF NOT EXISTS profesores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dni TEXT UNIQUE,
        nombre TEXT,
        password TEXT,
        cursos_permitidos TEXT,
        requiere_cambio_clave INTEGER DEFAULT 1
    )`);

    // Tabla de documentos cargados en el servidor
    db.run(`CREATE TABLE IF NOT EXISTS documentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT,
        curso TEXT,
        nombre_original TEXT,
        ruta_archivo TEXT,
        fecha_subida DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Profesor de prueba inicial (seteado en 0 para que este entre directo sin pedir cambio)
    // DNI de acceso: 12345678 | Contraseña de acceso: 123456
    db.get("SELECT COUNT(*) AS count FROM profesores", [], (err, row) => {
        if (row.count === 0) {
            db.run("INSERT INTO profesores (dni, nombre, password, cursos_permitidos, requiere_cambio_clave) VALUES (?, ?, ?, ?, ?)", 
            ['12345678', 'Profesor de Prueba', '123456', '4-1,4-2,5-2,6-2,7-2', 0]);
        }
    });
});

// Middlewares para procesar datos
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir las carpetas y archivos estáticos del frontend
app.use('/archivos', express.static(path.join(__dirname, 'archivos')));
app.use(express.static(__dirname));


// ==========================================
//             RUTAS DE LA API
// ==========================================

// 1. Iniciar sesión y comprobar estado de la contraseña
app.post('/api/login', (req, res) => {
    const { dni, password } = req.body;

    db.get("SELECT * FROM profesores WHERE dni = ? AND password = ?", [dni, password], (err, row) => {
        if (err) return res.status(500).json({ error: "Error interno en el servidor local." });
        if (!row) return res.status(401).json({ error: "DNI o contraseña incorrectos." });

        // Devolvemos si es obligatorio que cambie la clave (1 = true, 0 = false)
        res.json({ 
            success: true, 
            dni: row.dni, 
            nombre: row.nombre,
            requiereCambio: row.requiere_cambio_clave === 1
        });
    });
});

// 2. Cambiar contraseña obligatoria (Reemplaza a cambiar_password.php)
app.post('/api/cambiar-password', (req, res) => {
    const { dni, nuevaPassword } = req.body;

    if (!nuevaPassword || nuevaPassword.length < 6) {
        return res.status(400).send("La contraseña debe tener al menos 6 caracteres.");
    }

    // Actualizamos la clave y reseteamos la bandera a 0
    const sql = "UPDATE profesores SET password = ?, requiere_cambio_clave = 0 WHERE dni = ?";

    db.run(sql, [nuevaPassword, dni], function(err) {
        if (err) return res.status(500).send("Error al actualizar la contraseña en la base de datos.");
        res.send("¡Contraseña actualizada con éxito!");
    });
});

// 3. Registrar nuevos profesores (Alta Profesores) desde el panel de administración
app.post('/api/registrar-profesor', (req, res) => {
    const { dni, nombre, password, cursos } = req.body; 
    const cursosCadena = Array.isArray(cursos) ? cursos.join(',') : cursos;

    if (!dni || !nombre || !password || !cursosCadena) {
        return res.status(400).send("Por favor, completá todos los campos y seleccioná al menos un curso.");
    }

    // Todo profesor nuevo se registra con la bandera en 1 por defecto
    const sql = "INSERT INTO profesores (dni, nombre, password, cursos_permitidos, requiere_cambio_clave) VALUES (?, ?, ?, ?, 1)";
    
    db.run(sql, [dni, nombre, password, cursosCadena], function(err) {
        if (err) {
            if (err.message.includes("UNIQUE")) {
                return res.status(400).send("Error: Ya existe un profesor registrado con ese DNI.");
            }
            return res.status(500).send("Error al registrar en la base de datos local.");
        }
        res.send(`¡Profesor ${nombre} registrado con éxito! Deberá cambiar su clave al ingresar.`);
    });
});

// 4. Obtener el perfil y las reglas de cursos del docente logueado
app.get('/api/profesor/:dni', (req, res) => {
    db.get("SELECT * FROM profesores WHERE dni = ?", [req.params.dni], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Profesor no encontrado." });
        res.json(row);
    });
});

// 5. Obtener el listado global de documentos para los alumnos y el panel
app.get('/api/documentos', (req, res) => {
    db.all("SELECT * FROM documentos ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 6. Subir y almacenar un archivo físico aplicando control de seguridad local
app.post('/api/subir', upload.single('input-archivo'), (req, res) => {
    const { titulo, dni, curso } = req.body;

    db.get("SELECT cursos_permitidos FROM profesores WHERE dni = ?", [dni], (err, rowDocente) => {
        if (err || !rowDocente) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).send("Error de autenticación local.");
        }

        const cursosPermitidos = rowDocente.cursos_permitidos.split(',');
        
        // Control estricto de reglas de curso
        if (!cursosPermitidos.includes(curso)) {
            if (req.file) fs.unlinkSync(req.file.path); // Borra el archivo de la carpeta para no desperdiciar espacio
            return res.status(403).send("¡Error de seguridad! No tenés autorización para este curso.");
        }

        if (!req.file) return res.status(400).send("Por favor, seleccioná un archivo válido.");

        const sql = "INSERT INTO documentos (titulo, curso, nombre_original, ruta_archivo) VALUES (?, ?, ?, ?)";
        db.run(sql, [titulo, curso, req.file.originalname, req.file.path], function(err) {
            if (err) return res.status(500).send("Error al registrar en el archivo de base de datos.");
            res.send("¡Archivo publicado con éxito!");
        });
    });
});

// Levantar el servidor local
app.listen(PORT, () => {
    console.log(`Servidor de BIBLIOTEC corriendo de forma local en http://localhost:${PORT}`);
});