import { addYears, isBefore, parse, setYear } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { t } from '../services/i18n.js';

const reMin  = /Мінімальна\s+ставка:\s*([\d\s]+)\s*грн/i;
const reStep = /Крок\s+ставки:\s*([\d\s]+)\s*грн/i;
const reEnd  = /Завершення\s+аукціону:\s*([0-3]?\d\.[01]?\d)\s*о\s*([0-2]?\d:[0-5]\d)/i;

export function parsePost(text, tz) {
    const m1 = reMin.exec(text || '');
    const m2 = reStep.exec(text || '');
    const m3 = reEnd.exec(text || '');
    if (!m1 || !m2 || !m3) throw new Error(t('parse.error'));

    const minBid = parseInt(m1[1].replace(/\s+/g, ''), 10);
    const step   = parseInt(m2[1].replace(/\s+/g, ''), 10);

    const [dd, mm] = m3[1].split('.').map(Number);
    const [HH, MM] = m3[2].split(':').map(Number);
    const nowZ = toZonedTime(new Date(), tz);
    let end = setYear(parse(`${dd}.${mm} ${HH}:${MM}`, 'd.M H:mm', nowZ), nowZ.getFullYear());
    if (isBefore(end, nowZ)) end = addYears(end, 1);
    return { minBid, step, end };
}
