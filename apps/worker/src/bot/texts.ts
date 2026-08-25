/**
 * Every user-visible string. Nothing is inlined in a handler: keeping them here
 * makes the whole product's voice reviewable in one file, and the structure is
 * already shaped for a second language (`texts.ru`, `texts.en`) when one is needed.
 *
 * Values that interpolate take arguments; the caller passes values that have
 * already been escaped with `esc`, because these strings go out as HTML.
 */
import { type Currency, formatMoney } from '@alnotica/shared';

export interface TextBundle {
  readonly common: typeof ru.common;
  readonly consent: typeof ru.consent;
  readonly client: typeof ru.client;
  readonly staff: typeof ru.staff;
  readonly reminders: typeof ru.reminders;
  readonly errors: typeof ru.errors;
  readonly broadcast: typeof ru.broadcast;
  readonly plans: typeof ru.plans;
}

const ru = {
  common: {
    back: '← Назад',
    cancel: 'Отмена',
    confirm: 'Подтвердить',
    yes: 'Да',
    no: 'Нет',
    more: 'Показать ещё',
    done: 'Готово',
    skip: 'Пропустить',
    menu: 'Меню',
    somethingWentWrong: 'Что-то пошло не так. Попробуйте ещё раз.',
    notFound: 'Не найдено.',
    unknownCommand: 'Не понимаю эту команду. Нажмите /start.',
  },

  consent: {
    title: 'Прежде чем продолжить',
    body: (policyUrl: string, offerUrl: string) =>
      [
        'Чтобы записать вас и присылать напоминания, мы сохраним ваше имя в Telegram и историю визитов.',
        `<a href="${policyUrl}">Политика обработки данных</a> · <a href="${offerUrl}">Оферта</a>`,
      ].join('\n\n'),
    accept: 'Принимаю',
    decline: 'Не сейчас',
    declined: 'Хорошо. Без согласия записать не получится — вернитесь, когда будете готовы.',
  },

  client: {
    greeting: (title: string, address: string | null) =>
      [`<b>${title}</b>`, address ? address : ''].filter(Boolean).join('\n'),
    book: 'Записаться',
    myAppointments: 'Мои записи',
    contacts: 'Контакты',
    chooseService: 'Выберите услугу:',
    chooseStaff: 'К кому записать?',
    anyStaff: 'Любой мастер',
    chooseTime: 'Выберите время',
    openCalendar: 'Выбрать время',
    otherDays: 'Другие дни',
    noSlots: 'Свободных слотов пока нет. Загляните позже или напишите мастеру.',
    serviceLine: (name: string, durationMin: number, priceMinor: number | null, currency: string) =>
      [
        name,
        `${durationMin} мин`,
        priceMinor === null ? null : formatMoney(priceMinor, currency as Currency),
      ]
        .filter(Boolean)
        .join(' · '),
    booked: 'Записали.',
    bookedCard: (service: string, when: string, staff: string, address: string | null) =>
      ['<b>Вы записаны</b>', service, when, `Мастер: ${staff}`, address ? address : '']
        .filter(Boolean)
        .join('\n'),
    pendingCard: 'Заявка отправлена. Мастер подтвердит её в течение часа.',
    reschedule: 'Перенести',
    cancelBooking: 'Отменить',
    cancelConfirm: 'Точно отменить запись?',
    cancelled: 'Запись отменена.',
    cancelTooLate: (hours: number) =>
      `До визита меньше ${hours} ч — отменить самостоятельно уже нельзя. Свяжитесь с мастером.`,
    contactStaff: 'Связаться с мастером',
    upcoming: 'Ближайшие записи:',
    past: 'Последние визиты:',
    noAppointments: 'Записей пока нет.',
    tooManyActive: (limit: number) =>
      `У вас уже ${limit} активных записи. Отмените одну, чтобы записаться снова.`,
    slotTaken: 'Этот слот только что заняли. Вот что ещё свободно:',
    confirmAttendance: 'Подтверждаю',
    confirmedAttendance: 'Спасибо, ждём вас.',
  },

  staff: {
    welcome: 'Здесь вы ведёте запись клиентов.',
    registerPrompt: 'Похоже, вы ещё не зарегистрированы. Создать кабинет?',
    registerStart: 'Создать кабинет',
    askTitle: 'Как называется ваше дело? Например «Груминг у Ани».',
    askKind: 'Чем вы занимаетесь?',
    askTimezone: 'В каком часовом поясе вы работаете?',
    askTimezoneSearch: 'Напишите город — найду часовой пояс.',
    askService:
      'Добавим первую услугу. Напишите название, длительность в минутах и цену.\nНапример: «Стрижка, 60, 3000».',
    askSchedule: 'Теперь график. Отметьте рабочие дни.',
    askScheduleHours: (weekday: string) =>
      `${weekday}: во сколько начинаете и заканчиваете? Например «09:00-18:00».`,
    registered: (link: string) =>
      [
        '<b>Кабинет готов.</b>',
        `Ваша ссылка для записи:\n${link}`,
        'Вставьте её в шапку профиля в соцсетях — клиент откроет её и запишется сам.',
      ].join('\n\n'),

    menuToday: 'Сегодня',
    menuCalendar: 'Календарь',
    menuServices: 'Услуги',
    menuSchedule: 'График',
    menuClients: 'Клиенты',
    menuStats: 'Статистика',
    menuBroadcast: 'Рассылка',
    menuSettings: 'Настройки',

    todayEmpty: 'На сегодня записей нет.',
    todayHeader: (date: string, count: number) => `<b>${date}</b> · записей: ${count}`,
    appointmentLine: (time: string, client: string, service: string) =>
      `${time} · ${client} · ${service}`,

    markNoShow: 'Не пришёл',
    markCame: 'Пришёл',
    clientHistory: 'История клиента',
    messageClient: 'Написать клиенту',
    manualBooking: 'Записать вручную',
    manualNoReminders:
      'У клиента нет Telegram — напоминания ему не придут. Отправьте ему ссылку-приглашение, чтобы включить их.',
    sendInvite: 'Отправить приглашение',

    servicesEmpty: 'Услуг пока нет.',
    addService: 'Добавить услугу',
    editService: 'Изменить',
    deleteService: 'Удалить',

    scheduleHeader: 'Рабочие часы',
    dayOff: 'Выходной',
    vacation: 'Отпуск',
    notWorkingTomorrow: 'Не работаю завтра',

    clientsEmpty: 'Клиентов пока нет.',
    clientCard: (name: string, visits: number, spent: string, noShows: number) =>
      [`<b>${name}</b>`, `Визитов: ${visits}`, `На сумму: ${spent}`, `Неявок: ${noShows}`].join(
        '\n',
      ),
    clientNote: 'Заметка',

    statsHeader: (days: number) => `<b>Статистика за ${days} дней</b>`,
    statsBody: (s: {
      total: number;
      completed: number;
      cancelled: number;
      noShow: number;
      noShowRate: string;
      revenue: string;
      newClients: number;
      returning: number;
    }) =>
      [
        `Записей: ${s.total}`,
        `Выполнено: ${s.completed}`,
        `Отмен: ${s.cancelled}`,
        `Неявок: ${s.noShow} (${s.noShowRate})`,
        `Выручка: ${s.revenue}`,
        `Новые клиенты: ${s.newClients} · повторные: ${s.returning}`,
      ].join('\n'),
    statsDelivery: (sent: number, confirmed: number) =>
      `Напоминания доставлены: ${sent}, подтвердили: ${confirmed}`,
    statsSaved: (amount: string) => `Напоминания сберегли примерно ${amount}`,
    statsTopServices: 'Популярные услуги:',

    digestHeader: (date: string) => `<b>Завтра, ${date}</b>`,
    digestEmpty: (date: string) => `Завтра, ${date}, записей нет.`,
    newBooking: 'Новая запись',
    bookingCancelled: 'Запись отменена',
    clientBlockedBot: 'Клиент заблокировал бота — напоминание не доставлено.',
    askNoShow: (client: string, service: string, time: string) =>
      `${client} был записан на ${service} в ${time}. Пришёл?`,

    settingsAutoConfirm: 'Автоподтверждение',
    settingsCancelWindow: 'Окно отмены',
    settingsReminders: 'Напоминания',
    settingsOwnBot: 'Свой бот',
    settingsLink: 'Ссылка на запись',
  },

  reminders: {
    dayBefore: (service: string, when: string, staff: string, address: string | null) =>
      ['<b>Напоминание</b>', `Завтра: ${service}`, when, `Мастер: ${staff}`, address ? address : '']
        .filter(Boolean)
        .join('\n'),
    hoursBefore: (hours: number, service: string, when: string, address: string | null) =>
      [`<b>Через ${hours} ч: ${service}</b>`, when, address ? address : '']
        .filter(Boolean)
        .join('\n'),
    confirmButton: 'Подтверждаю',
    rescheduleButton: 'Перенести',
    cancelButton: 'Отменить',
  },

  errors: {
    slotTaken: 'Этот слот только что заняли.',
    slotNotAvailable: 'Это время недоступно. Выберите другое.',
    outsideCancelWindow: 'Отменить самостоятельно уже поздно — напишите мастеру.',
    rateLimited: 'Слишком много действий. Подождите минуту.',
    planLimit: (limit: number) =>
      `На бесплатном тарифе ${limit} записей в месяц, лимит исчерпан. Новые записи от клиентов не создаются — существующие работают.`,
    planFeature: 'Эта возможность доступна на платном тарифе.',
    notFound: 'Не найдено.',
  },

  broadcast: {
    title: 'Рассылка',
    audienceAll: 'Все клиенты',
    audienceRecent: (days: number) => `Были за ${days} дней`,
    audienceDormant: (days: number) => `Не были больше ${days} дней`,
    audienceService: 'Пользовались услугой',
    unsubscribe: 'Отписаться',
    unsubscribed:
      'Вы отписаны от рассылок этого мастера. Напоминания о ваших записях продолжат приходить.',
    limitMonthly: (max: number) => `Больше ${max} рассылок в месяц нельзя.`,
    limitCooldown: (hours: number) => `С прошлой рассылки должно пройти ${hours} ч.`,
    limitTooYoung: (days: number) => `Рассылки открываются через ${days} дней после регистрации.`,
    limitEmpty: 'В выбранной аудитории никого нет.',
    onModeration: 'Первые три рассылки проверяет модератор. Отправим сразу после проверки.',
    approved: 'Рассылка одобрена и отправляется.',
    rejected: 'Рассылка отклонена модератором.',
    report: (sent: number, failed: number) =>
      `Рассылка завершена. Доставлено: ${sent}, не доставлено: ${failed}.`,
    windowOpened: 'Окно освободилось',
    windowOpenedOffer: (service: string, when: string) =>
      `Освободилось окно: ${service}, ${when}. Записаться?`,
    windowOpenedButton: 'Предложить окно клиентам',
  },

  plans: {
    upgrade: 'Хочу Pro',
    pricing: [
      'Pro — 990 ₽/мес: свой бот, рассылки, без лимита записей.',
      'Team — 2490 ₽/мес: всё из Pro плюс несколько сотрудников.',
      'При оплате за год — минус 20%.',
    ].join('\n'),
    requestSent: 'Заявка отправлена. Свяжемся в ближайшее время.',
  },
} as const;

export const texts: TextBundle = ru;

export type Texts = typeof ru;
