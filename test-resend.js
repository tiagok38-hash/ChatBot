require("dotenv").config();
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
resend.emails.send({
    from: "iSti Alert <onboarding@resend.dev>",
    to: "lojaistore@gmail.com",
    subject: "Teste Resend",
    text: "Funcionou!"
}).then(console.log).catch(console.error);
