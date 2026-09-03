process.env.TZ = 'Europe/Madrid';
require('dotenv').config();

module.exports = {
  OFFICIAL_PHONE: process.env.OFFICIAL_PHONE || '34695384814',
  OFFICIAL_PHONE_FORMATTED: '+34 695 38 48 14',
  CLINIC_NAME: 'Clínica Dental Dr. Zaragozá',
  TIMEZONE: 'Europe/Madrid',
  PORT: process.env.PORT || 3000,
  DATABASE_URL: process.env.DATABASE_URL || '',
  SUBSCRIPTION_ACTIVE: process.env.SUBSCRIPTION_ACTIVE !== 'false',
  AUTH_DIR: process.env.AUTH_DIR || './auth_info_baileys',
  DATA_DIR: process.env.DATA_DIR || './data',

  // Identidad oficial clínica: Blanco y Rosa/Coral #F36279
  THEME: {
    primary: '#F36279',
    primaryHover: '#E05269',
    background: '#FAFAFB',
    cardBg: '#FFFFFF',
    text: '#2D3748',
    border: '#E2E8F0',
  },

  // Aspecto de citas en calendario: tarjeta blanca con borde #F36279
  EVENT_STYLE: {
    bg: '#FFFFFF',
    border: '#F36279',
    text: '#2D3748',
  }
};
