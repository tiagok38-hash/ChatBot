require('dotenv').config();
const nodemailer = require('nodemailer');

const mailTransporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: process.env.MAIL_PORT || 465,
    secure: true,
    family: 4,
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
    },
    tls: {
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
