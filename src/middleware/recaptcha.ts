import 'dotenv/config';
export async function verifyRecaptcha(token: string): Promise<boolean> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  console.log('secretKey', secretKey);
  
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `secret=${secretKey}&response=${token}`,
    });

    const data = await response.json();
    
    console.log('[RECAPTCHA] Resposta do Google:', JSON.stringify(data, null, 2));
    
    // reCAPTCHA v3 retorna um score de 0.0 a 1.0
    // 1.0 é muito provável que seja humano, 0.0 é muito provável que seja bot
    // Geralmente considera-se 0.5 como threshold aceitável
    
    // Se não houver score (chaves de teste), aceitar apenas success
    if (data.score === undefined) {
      console.log('[RECAPTCHA] Sem score - validando apenas success');
      return data.success;
    }
    
    return data.success && data.score >= 0.5;
  } catch (error) {
    console.error('Erro ao verificar reCAPTCHA:', error);
    return false;
  }
}
