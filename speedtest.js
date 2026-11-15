'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const ATTEMPTS = 10;
const WARMUP_ATTEMPTS = 1; // первый запрос тестовый
const TIMEOUT_MS = 60_000;

function fetchOnce(targetUrl, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Некорректный URL: ${targetUrl}`));
    }

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'speedtest-cli/1.0',
          'Accept': '*/*',
          'Accept-Encoding': 'identity', // отключаем сжатие
          'Cache-Control': 'no-cache', // вырубили кэш
          'Pragma': 'no-cache',
        },
      },
      (res) => {
        // Редиректы
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // вычитываем и выбрасываем
          const nextUrl = new URL(res.headers.location, url).toString();
          return fetchOnce(nextUrl, { timeoutMs }).then(resolve, reject);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} для ${url.toString()}`));
        }

        let bytes = 0;
        const startedAt = process.hrtime.bigint();

        res.on('data', (chunk) => {
          bytes += chunk.length;
        });

        res.on('end', () => {
          const endedAt = process.hrtime.bigint();
          const durationMs = Number(endedAt - startedAt) / 1e6;
          resolve({ bytes, durationMs, statusCode: res.statusCode });
        });

        res.on('error', reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Таймаут ${timeoutMs} мс`));
    });

    req.on('error', reject);
    req.end();
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function run(targetUrl) {
  if (!targetUrl) {
    console.error('Использование: node speedtest.js <URL>');
    console.error('Пример: node speedtest.js https://speed.cloudflare.com/__down?bytes=10000000');
    process.exit(1);
  }

  console.log(`Цель:            ${targetUrl}`);
  console.log(`Попыток замера:  ${ATTEMPTS} (+${WARMUP_ATTEMPTS} тестовое скачивание)`);
  console.log('');

  // Прогрев
  try {
    await fetchOnce(targetUrl);
  } catch (e) {
    console.warn(`тест не удался: ${e.message} (продолжаем)`);
  }

  let totalBytes = 0;
  let totalMs = 0;
  let okCount = 0;
  let failCount = 0;

  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const { bytes, durationMs } = await fetchOnce(targetUrl);
      totalBytes += bytes;
      totalMs += durationMs;
      okCount++;

      const mbps = bytes > 0 && durationMs > 0
        ? (bytes * 8) / (durationMs / 1000) / 1_000_000
        : 0;

      console.log(
        `#${String(i).padStart(2, ' ')}  ` +
        `${formatBytes(bytes).padStart(10)}  ` +
        `${durationMs.toFixed(1).padStart(8)} мс  ` +
        `${mbps.toFixed(2).padStart(9)} Мбит/с`
      );
    } catch (e) {
      failCount++;
      console.log(`#${String(i).padStart(2, ' ')}  ошибка: ${e.message}`);
    }
  }

  console.log('');

  if (okCount === 0) {
    console.error('Все запросы завершились ошибкой — результат невозможен.');
    process.exit(2);
  }

  const avgMs = totalMs / okCount;
  const avgBytes = totalBytes / okCount;
  const avgMbps = avgMs > 0 ? (totalBytes * 8) / (totalMs / 1000) / 1_000_000 : 0;
  const avgMBs = avgMs > 0 ? (totalBytes / (1024 * 1024)) / (totalMs / 1000) : 0;

  // Таблица результата

  console.log('—'.repeat(60));
  console.log(`Успешных замеров:     ${okCount} / ${ATTEMPTS}${failCount ? ` (ошибок: ${failCount})` : ''}`);
  console.log(`Скачано всего:        ${formatBytes(totalBytes)} (${totalBytes} байт)`);
  console.log(`Средний размер:       ${formatBytes(avgBytes)} за запрос`);
  console.log(`Среднее время:        ${avgMs.toFixed(1)} мс за запрос`);
  console.log('');
  console.log(`Средняя скорость:     ${avgMbps.toFixed(2)} Мбит/с`);
  console.log(`                      ${avgMBs.toFixed(2)} МБ/с`);
  console.log('—'.repeat(60));
}

const [, , url] = process.argv;
run(url).catch((e) => {
  console.error('Фатальная ошибка:', e.message);
  process.exit(1);
});