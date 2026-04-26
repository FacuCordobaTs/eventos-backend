import { createPool } from 'mysql2/promise';

export const pool = createPool({
    host: 'localhost',
    user: 'facu',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306,
    timezone: 'Z'
})

pool
    .getConnection()
    .then((connection) => {
        console.log('Connected to the database')
        connection.release()
    })
    .catch((err) => {
        console.error('Error connecting to the database', err)
    })