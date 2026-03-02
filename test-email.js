require('dotenv').config();
const nodemailer = require('nodemailer');
const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const mailTransporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.MAIL_PORT || '465'),
    secure: (process.env.MAIL_PORT === '465' || !process.env.MAIL_PORT),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    family: 4,
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
    },
    tls: {
        rejectUnauthorized: false,
        servername: process.env.MAIL_HOST || 'smtp.gmail.com'
    }
});

mailTransporter.sendMail({
    from: `"iSti Alert 🤖" <${process.env.MAIL_USER}>`,
    to: process.env.MAIL_USER,
    subject: "🚨 Teste de Transferência",
    text: "Teste de email."
}, (error, info) => {
    if (error) {
        console.error("ERRO COMPLETO:", error);
    } else {
        console.log("SUCESSO:", info);
    }
});
