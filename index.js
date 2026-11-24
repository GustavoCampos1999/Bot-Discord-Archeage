const {
    Client,
    GatewayIntentBits,
    Partials,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    PermissionsBitField,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// ===== SERVIDOR WEB (RENDER + UPTIMEROBOT) =====
const app = express();
app.get('/', (req, res) => res.send('Bot do Trolleibre está online!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor web rodando na porta ${PORT}`));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// ===== CONSTANTES =====
const DATA_FILE = path.join(__dirname, 'data.json');
const CHECK_INTERVAL_MS = 30 * 1000;
const BRT_OFFSET_MS = -3 * 60 * 60 * 1000; // Horário de Brasília (UTC-3)
const ELU_USER_ID = '210789096837218306';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const EPHEMERAL_AUTO_DELETE_MS = 14 * 60 * 1000 + 30 * 1000; // 14m30s (dentro do limite de 15min do token do Discord)

const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || '';
const USE_JSONBIN = JSONBIN_KEY !== '' && JSONBIN_BIN_ID !== '';

// ===== ESTADO PADRÃO =====
const DEFAULT_STATE = {
    panelChannelId: null,
    panelMessageId: null,
    lastAlertMessageId: null,
    packsMenuMessageId: null,

    // 1. Freedich Gold Trader (2h ON / 2h OFF ou MIA)
    freedich: {
        status: 'MIA',        // 'ON' | 'OFF' | 'MIA'
        nextChangeTime: null, // Timestamp em ms da próxima mudança
        lastActionTime: null  // Timestamp em ms do último evento ON/OFF
    },

    // 2. Packs (configurado apenas via !packs pelo EluDelu; botão Replantei só no PV do Gestor)
    packs: {
        finishTime: null,
        notified: false,
        recipients: ['elu', 'trollei', 'tock'],
        manager: 'elu'
    },

    // Membros salvos para seleção no menu !packs
    members: {
        elu:      { name: 'EluDelu',   id: '210789096837218306' },
        trollei:  { name: 'Trollei',   id: '372538969805553664' },
        tock:     { name: 'TockTock',  id: '467871652517249034' },
        tonelada: { name: 'Tonelada',  id: '237228450455224321' }
    },

    // 3. Costume & Undergarment individual (chave = Discord User ID)
    wardrobe: {}
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let isUpdatingPanel = false;
let pendingForceResend = false;
let saveQueue = Promise.resolve();

function mergeState(saved) {
    if (!saved || typeof saved !== 'object') return;

    const mergedMembers = (saved.members && Object.keys(saved.members).length > 0)
        ? saved.members
        : state.members;

    const memberKeys = Object.keys(mergedMembers);

    const savedFreedich = saved.freedich && typeof saved.freedich === 'object' ? saved.freedich : {};
    const validStatus = ['ON', 'OFF', 'MIA'].includes(savedFreedich.status) ? savedFreedich.status : 'MIA';
    const nextChangeTime = typeof savedFreedich.nextChangeTime === 'number' ? savedFreedich.nextChangeTime : null;
    const lastActionTime = typeof savedFreedich.lastActionTime === 'number'
        ? savedFreedich.lastActionTime
        : (nextChangeTime ? nextChangeTime - TWO_HOURS_MS : null);

    const savedPacks = saved.packs && typeof saved.packs === 'object' ? saved.packs : {};
    const recipients = Array.isArray(savedPacks.recipients)
        ? savedPacks.recipients.filter(k => mergedMembers[k])
        : DEFAULT_STATE.packs.recipients.filter(k => mergedMembers[k]);

    const manager = (savedPacks.manager && mergedMembers[savedPacks.manager])
        ? savedPacks.manager
        : (mergedMembers[DEFAULT_STATE.packs.manager] ? DEFAULT_STATE.packs.manager : (memberKeys[0] || null));

    const savedWardrobe = (saved.wardrobe && typeof saved.wardrobe === 'object') ? saved.wardrobe : {};

    state = {
        panelChannelId: saved.panelChannelId || null,
        panelMessageId: saved.panelMessageId || null,
        lastAlertMessageId: saved.lastAlertMessageId || null,
        packsMenuMessageId: saved.packsMenuMessageId || null,
        freedich: {
            status: validStatus,
            nextChangeTime,
            lastActionTime
        },
        packs: {
            finishTime: typeof savedPacks.finishTime === 'number' ? savedPacks.finishTime : null,
            notified: Boolean(savedPacks.notified),
            recipients,
            manager
        },
        members: mergedMembers,
        wardrobe: savedWardrobe
    };
}

// ===== PERSISTÊNCIA (JSONBin.io + data.json) =====
async function loadData() {
    if (USE_JSONBIN) {
        try {
            const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
                headers: { 'X-Master-Key': JSONBIN_KEY }
            });
            if (res.ok) {
                const json = await res.json();
                const saved = json.record;
                if (saved && Object.keys(saved).length > 0) {
                    mergeState(saved);
                    console.log('Estado carregado do JSONBin.io');
                    return;
                }
            }
        } catch (err) {
            console.error('Erro ao carregar do JSONBin, tentando arquivo local:', err.message);
        }
    }

    if (fs.existsSync(DATA_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            mergeState(saved);
            console.log('Estado carregado do arquivo local');
        } catch (err) {
            console.error('Erro ao ler data.json:', err.message);
        }
    } else {
        await saveData();
    }
}

function saveData() {
    const snapshot = JSON.stringify(state, null, 2);
    saveQueue = saveQueue.then(async () => {
        try {
            fs.writeFileSync(DATA_FILE, snapshot);
        } catch (e) {
            console.error('Erro ao salvar data.json:', e.message);
        }

        if (USE_JSONBIN) {
            try {
                await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Master-Key': JSONBIN_KEY
                    },
                    body: snapshot
                });
            } catch (err) {
                console.error('Erro ao salvar no JSONBin:', err.message);
            }
        }
    });
    return saveQueue;
}

// ===== UTILITÁRIOS DE TEMPO E FORMATAÇÃO =====
function formatDuration(ms) {
    if (ms <= 0) return '0m';
    const totalMinutes = Math.floor(ms / (60 * 1000));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

/**
 * Converte string HH:MM (ex: "08:30", "8:30", "08h30", "0830") para timestamp ms no horário de Brasília (UTC-3).
 */
function parseBrasiliaTimeToday(input) {
    if (!input) return null;
    const clean = input.trim();
    if (!clean) return null;

    let hour, minute;
    const sepMatch = clean.match(/^(\d{1,2})\s*[:hH]\s*(\d{2})$/);
    if (sepMatch) {
        hour = parseInt(sepMatch[1], 10);
        minute = parseInt(sepMatch[2], 10);
    } else {
        const digitsMatch = clean.match(/^(\d{3,4})$/);
        if (!digitsMatch) return null;
        const padded = digitsMatch[1].padStart(4, '0');
        hour = parseInt(padded.slice(0, 2), 10);
        minute = parseInt(padded.slice(2, 4), 10);
    }

    if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }

    const nowMs = Date.now();
    const nowBrt = new Date(nowMs + BRT_OFFSET_MS);
    const year = nowBrt.getUTCFullYear();
    const month = nowBrt.getUTCMonth();
    const day = nowBrt.getUTCDate();

    let eventTs = Date.UTC(year, month, day, hour, minute, 0, 0) - BRT_OFFSET_MS;
    if (eventTs > nowMs + 2 * 60 * 1000) {
        eventTs -= 24 * 60 * 60 * 1000;
    }

    return eventTs;
}

/**
 * Faz o parse da duração no formato (dias)(horas)(minutos).
 * Aceita: "(3)(0)(0)", "(2)(14)(30)", "2 14 30", "2d 14h 30m", "3", etc.
 */
function parseDHM(input) {
    if (!input || !input.trim()) return null;
    const text = input.trim().toLowerCase();

    let days = 0;
    let hours = 0;
    let minutes = 0;

    if (/[dhm]/.test(text)) {
        const dMatch = text.match(/(\d+)\s*d/);
        const hMatch = text.match(/(\d+)\s*h/);
        const mMatch = text.match(/(\d+)\s*m/);
        if (!dMatch && !hMatch && !mMatch) return null;
        days = dMatch ? parseInt(dMatch[1], 10) : 0;
        hours = hMatch ? parseInt(hMatch[1], 10) : 0;
        minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
    } else {
        const nums = text.match(/\d+/g);
        if (!nums || nums.length === 0 || nums.length > 3) return null;
        if (nums.length === 1) {
            days = parseInt(nums[0], 10);
        } else if (nums.length === 2) {
            days = parseInt(nums[0], 10);
            hours = parseInt(nums[1], 10);
        } else {
            days = parseInt(nums[0], 10);
            hours = parseInt(nums[1], 10);
            minutes = parseInt(nums[2], 10);
        }
    }

    const totalMs = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
    if (isNaN(totalMs) || totalMs <= 0) return null;
    return totalMs;
}

function getMember(key) {
    return state.members[key] || null;
}

function getMention(key) {
    const m = getMember(key);
    if (!m) return `**${key}**`;
    return m.id ? `<@${m.id}>` : `**${m.name}**`;
}

async function sendDMByUserId(userId, payload) {
    if (!userId) return false;
    try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return false;
        await user.send(typeof payload === 'string' ? { content: payload } : payload);
        return true;
    } catch (err) {
        return false;
    }
}

function isAdmin(interaction) {
    return Boolean(interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
}

async function replyEphemeral(interaction, payload) {
    const data = typeof payload === 'string' ? { content: payload, ephemeral: true } : { ...payload, ephemeral: true };
    const res = await interaction.reply(data);
    setTimeout(() => {
        interaction.deleteReply().catch(() => null);
    }, EPHEMERAL_AUTO_DELETE_MS);
    return res;
}

// ===== MOTOR DE CICLO DO FREEDICH =====
function advanceFreedichCycle(now = Date.now()) {
    const f = state.freedich;
    if (f.status === 'MIA' || !f.nextChangeTime) return [];

    const events = [];
    while (now >= f.nextChangeTime) {
        const changeTs = f.nextChangeTime;
        f.status = f.status === 'ON' ? 'OFF' : 'ON';
        f.lastActionTime = changeTs;
        f.nextChangeTime = changeTs + TWO_HOURS_MS;
        events.push({
            status: f.status,
            changedAt: changeTs,
            nextAt: f.nextChangeTime
        });
    }
    return events;
}

// ===== PAINEL PRINCIPAL (APENAS FREEDICH GOLD TRADER + BOTÃO COSTUME/UNDER) =====
function buildFreedichEmbed() {
    const f = state.freedich;
    const embed = new EmbedBuilder().setTitle('🪙 Freedich — Gold Trader');

    if (f.status === 'MIA' || !f.nextChangeTime) {
        embed
            .setColor('#95a5a6')
            .setDescription(
                `# Status: ⚪ MIA\n\n` +
                `Clique em **➕ Adicionar Timer** abaixo e informe a hora em que o Gold Trader **entrou** ou **saiu** da ilha.`
            );
        return embed;
    }

    const nextTs = f.nextChangeTime;
    const followingTs = nextTs + TWO_HOURS_MS;
    const lastActionMs = f.lastActionTime || (nextTs - TWO_HOURS_MS);

    const lastDiscordTs = Math.floor(lastActionMs / 1000);
    const nextDiscordTs = Math.floor(nextTs / 1000);
    const followingDiscordTs = Math.floor(followingTs / 1000);

    if (f.status === 'OFF') {
        embed
            .setColor('#e74c3c')
            .setDescription(
                `# Status: 🔴 OFF\n` +
                `🕒 Último registro: Saiu às <t:${lastDiscordTs}:T>\n\n\n` +
                `🪙 Gold trader vai voltar a ilha <t:${nextDiscordTs}:R> — às <t:${nextDiscordTs}:t>\n` +
                `⛵ E saíra novamente <t:${followingDiscordTs}:R> — às <t:${followingDiscordTs}:t>`
            );
    } else {
        embed
            .setColor('#2ecc71')
            .setDescription(
                `# Status: 🟢 ON\n` +
                `🕒 Último registro: Entrou às <t:${lastDiscordTs}:T>\n\n\n` +
                `⛵ Gold trader vai sair da ilha <t:${nextDiscordTs}:R> — às <t:${nextDiscordTs}:t>\n` +
                `🪙 E voltará novamente <t:${followingDiscordTs}:R> — às <t:${followingDiscordTs}:t>`
            );
    }

    return embed;
}

function buildPanelPayload() {
    const isMia = state.freedich.status === 'MIA' || !state.freedich.nextChangeTime;

    const rowMain = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('freedich_mia')
            .setLabel('❓ MIA')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(isMia),
        new ButtonBuilder()
            .setCustomId('freedich_add_timer')
            .setLabel('➕ Adicionar Timer')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!isMia),
        new ButtonBuilder()
            .setCustomId('wardrobe_menu')
            .setLabel('👘 Costume / Undergarment')
            .setStyle(ButtonStyle.Primary)
    );

    return {
        embeds: [buildFreedichEmbed()],
        components: [rowMain]
    };
}

// ===== COSTUME & UNDERGARMENT (EPHEMERAL + DM) =====
function buildWardrobeWashButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('wardrobe_wash_both')
            .setLabel('🧼 Lavei Costume e Undergarment (30d)')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('wardrobe_wash_costume')
            .setLabel('👘 Lavei Apenas Costume (30d)')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('wardrobe_wash_under')
            .setLabel('🩲 Lavei Apenas Undergarment (30d)')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildWardrobeMenuPayload(userId, notice = '') {
    const data = state.wardrobe[userId];
    const now = Date.now();
    let statusText = 'Você ainda não cadastrou nenhum timer de **Costume** ou **Undergarment**.';

    if (data && (data.costumeFinishTime || data.undergarmentFinishTime)) {
        const lines = [];
        if (data.costumeFinishTime) {
            const cTs = Math.floor(data.costumeFinishTime / 1000);
            lines.push(
                now >= data.costumeFinishTime
                    ? `👘 **Costume:** ⚠️ Expirado! (<t:${cTs}:R>)`
                    : `👘 **Costume:** falta **${formatDuration(data.costumeFinishTime - now)}** — expira em <t:${cTs}:f> (<t:${cTs}:R>)`
            );
        } else {
            lines.push('👘 **Costume:** *não cadastrado*');
        }

        if (data.undergarmentFinishTime) {
            const uTs = Math.floor(data.undergarmentFinishTime / 1000);
            lines.push(
                now >= data.undergarmentFinishTime
                    ? `🩲 **Undergarment:** ⚠️ Expirado! (<t:${uTs}:R>)`
                    : `🩲 **Undergarment:** falta **${formatDuration(data.undergarmentFinishTime - now)}** — expira em <t:${uTs}:f> (<t:${uTs}:R>)`
            );
        } else {
            lines.push('🩲 **Undergarment:** *não cadastrado*');
        }

        statusText = lines.join('\n');
    }

    const rowActions = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('wardrobe_open_modal')
            .setLabel('⏱️ Definir Tempo (Costume / Under)')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('wardrobe_clear_mine')
            .setLabel('🗑️ Desativar Meus Alertas')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!data || (!data.costumeFinishTime && !data.undergarmentFinishTime))
    );

    const header = notice ? `${notice}\n\n` : '';
    return {
        content:
            `${header}**👘 Costume & Undergarment (Aviso no PV — 30 Dias)**\n` +
            `Quando expirar, o bot avisa no seu **PV** com os botões de lavar (renova por **30 dias**).\n\n` +
            `${statusText}`,
        components: [rowActions],
        ephemeral: true
    };
}

// ===== PACKS (!packs EXCLUSIVO ELUDELU) =====
function buildPacksConfigPayload() {
    const memberEntries = Object.entries(state.members);
    const rows = [];

    if (memberEntries.length > 0) {
        const recipientOptions = memberEntries.slice(0, 25).map(([key, m]) => ({
            label: m.name,
            description: `ID: ${m.id}`,
            value: key,
            default: state.packs.recipients.includes(key)
        }));

        const selectRecipients = new StringSelectMenuBuilder()
            .setCustomId('packs_select_recipients')
            .setPlaceholder('Escolha quem RECEBE o alerta no PV')
            .setMinValues(1)
            .setMaxValues(recipientOptions.length)
            .addOptions(recipientOptions);

        const managerOptions = memberEntries.slice(0, 25).map(([key, m]) => ({
            label: m.name,
            description: `ID: ${m.id}`,
            value: key,
            default: state.packs.manager === key
        }));

        const selectManager = new StringSelectMenuBuilder()
            .setCustomId('packs_select_manager')
            .setPlaceholder('Escolha a pessoa GESTORA (botão Replantei no PV)')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(managerOptions);

        rows.push(
            new ActionRowBuilder().addComponents(selectRecipients),
            new ActionRowBuilder().addComponents(selectManager)
        );
    }

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('packs_set_time')
            .setLabel('⏱️ Definir Tempo Packs')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('packs_add_member')
            .setLabel('➕ Adicionar / Editar Pessoa')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('packs_remove_member')
            .setLabel('🗑️ Remover Pessoa')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(memberEntries.length === 0),
        new ButtonBuilder()
            .setCustomId('packs_close_menu')
            .setLabel('❌ Fechar Menu')
            .setStyle(ButtonStyle.Secondary)
    );
    rows.push(actionRow);

    const p = state.packs;
    const now = Date.now();
    let timerLine = '⚪ **Timer dos Packs:** Sem timer ativo.';
    if (p.finishTime) {
        const ts = Math.floor(p.finishTime / 1000);
        if (now >= p.finishTime) {
            timerLine = `✅ **Timer dos Packs:** PRONTOS PARA COLHER! (<t:${ts}:R>)`;
        } else {
            timerLine = `⏳ **Timer dos Packs:** falta **${formatDuration(p.finishTime - now)}** — prontos em <t:${ts}:f> (<t:${ts}:R>)`;
        }
    }

    const managerText = p.manager ? getMention(p.manager) : '*Não definido*';
    const recipientsText = p.recipients.length > 0
        ? p.recipients.map(k => getMention(k)).join(', ')
        : '*Ninguém*';

    return {
        content:
            `**⚙️ Configuração de Packs (Exclusivo EluDelu)**\n` +
            `${timerLine}\n` +
            `👑 **Gestor(a) (recebe botão Replantei no PV):** ${managerText}\n` +
            `📩 **Recebem alerta no PV:** ${recipientsText}`,
        components: rows
    };
}

// ===== GESTÃO DE MENSAGENS DO CANAL (ZERO SPAM + PAINEL SEMPRE POR ÚLTIMO) =====
async function deleteLastAlertMessage(channel) {
    if (!state.lastAlertMessageId || !channel) return;
    try {
        const alertMsg = await channel.messages.fetch(state.lastAlertMessageId).catch(() => null);
        if (alertMsg) await alertMsg.delete().catch(() => null);
    } catch (e) {}
    state.lastAlertMessageId = null;
}

async function sendNewPanel(channel) {
    const sentMessage = await channel.send(buildPanelPayload());

    if (state.panelMessageId && state.panelChannelId === channel.id && state.panelMessageId !== sentMessage.id) {
        try {
            const oldMsg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => null);
        } catch (e) {}
    }

    // Remove quaisquer mensagens antigas do próprio bot que não sejam o painel novo, o alerta ativo ou o menu !packs aberto
    try {
        const recent = await channel.messages.fetch({ limit: 15 }).catch(() => null);
        if (recent) {
            for (const msg of recent.values()) {
                if (
                    msg.author.id === client.user.id &&
                    msg.id !== sentMessage.id &&
                    msg.id !== state.lastAlertMessageId &&
                    msg.id !== state.packsMenuMessageId
                ) {
                    await msg.delete().catch(() => null);
                }
            }
        }
    } catch (e) {}

    state.panelChannelId = sentMessage.channel.id;
    state.panelMessageId = sentMessage.id;
    await saveData();
}

async function updatePanel(forceResend = false) {
    if (!state.panelChannelId) return;

    if (isUpdatingPanel) {
        if (forceResend) pendingForceResend = true;
        return;
    }

    isUpdatingPanel = true;
    try {
        const channel = await client.channels.fetch(state.panelChannelId).catch(() => null);
        if (!channel) return;

        let shouldResend = forceResend || pendingForceResend;
        pendingForceResend = false;

        if (!shouldResend) {
            const lastMessages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
            const lastMsg = lastMessages ? lastMessages.first() : null;
            if (lastMsg && lastMsg.id !== state.panelMessageId) {
                shouldResend = true;
            }
        }

        if (shouldResend) {
            await sendNewPanel(channel);
            return;
        }

        const message = state.panelMessageId
            ? await channel.messages.fetch(state.panelMessageId).catch(() => null)
            : null;

        if (!message) {
            await sendNewPanel(channel);
            return;
        }

        await message.edit(buildPanelPayload());
    } catch (error) {
        console.error('Erro ao atualizar o painel:', error.message);
    } finally {
        isUpdatingPanel = false;
        if (pendingForceResend) {
            pendingForceResend = false;
            updatePanel(true);
        }
    }
}

// ===== LOOP DE VERIFICAÇÃO DOS 3 TIMERS =====
async function runChecks() {
    const now = Date.now();
    let changed = false;
    let shouldResendPanel = false;

    // 1. Freedich Gold Trader (2h ON / 2h OFF)
    const freedichEvents = advanceFreedichCycle(now);
    if (freedichEvents.length > 0) {
        changed = true;
        if (state.panelChannelId) {
            const channel = await client.channels.fetch(state.panelChannelId).catch(() => null);
            if (channel) {
                await deleteLastAlertMessage(channel);

                const latestEvent = freedichEvents[freedichEvents.length - 1];
                const changedUnix = Math.floor(latestEvent.changedAt / 1000);
                const nextUnix = Math.floor(latestEvent.nextAt / 1000);

                let alertText = '';
                if (latestEvent.status === 'ON') {
                    alertText =
                        `🪙 **FREEDICH GOLD TRADER ON!**\n` +
                        `O Gold Trader **ENTROU** na ilha às <t:${changedUnix}:T>!\n` +
                        `Ele fica ativo por 2h e sai às <t:${nextUnix}:t> (<t:${nextUnix}:R>).`;
                } else {
                    alertText =
                        `⛵ **FREEDICH GOLD TRADER OFF!**\n` +
                        `O Gold Trader **SAIU** da ilha às <t:${changedUnix}:T>!\n` +
                        `Ele fica fora por 2h e volta às <t:${nextUnix}:t> (<t:${nextUnix}:R>).`;
                }

                const sentAlert = await channel.send(alertText).catch(() => null);
                if (sentAlert) {
                    state.lastAlertMessageId = sentAlert.id;
                }
                shouldResendPanel = true;
            }
        }
    }

    // 2. Packs prontos (alerta no PV + botão Replantei SOMENTE no PV do Gestor)
    if (state.packs.finishTime && now >= state.packs.finishTime && !state.packs.notified) {
        state.packs.notified = true;
        changed = true;

        const targetKeys = new Set(state.packs.recipients);
        if (state.packs.manager) targetKeys.add(state.packs.manager);

        for (const key of targetKeys) {
            const m = getMember(key);
            if (!m || !m.id) continue;

            const isManager = key === state.packs.manager;
            if (isManager) {
                const replantRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('packs_replant')
                        .setLabel('🌱 Replantei (Resetar p/ 3 Dias)')
                        .setStyle(ButtonStyle.Success)
                );
                await sendDMByUserId(m.id, {
                    content:
                        `🌿 **Os packs estão prontos para colher!**\n` +
                        `Você é a pessoa **Gestora** configurada.\n` +
                        `Assim que replantar os novos packs, clique no botão abaixo para resetar o timer para **3 dias**:`,
                    components: [replantRow]
                });
            } else {
                await sendDMByUserId(m.id, {
                    content:
                        `🌿 **Os packs estão prontos para colher!**\n` +
                        `Aviso automático para você que está na lista de alertas de Packs.`
                });
            }
        }
    }

    // 3. Costume & Undergarment individual (aviso no PV com os 3 botões de lavar)
    for (const [userId, data] of Object.entries(state.wardrobe)) {
        const costumeExpired = Boolean(data.costumeFinishTime && now >= data.costumeFinishTime && !data.costumeNotified);
        const underExpired = Boolean(data.undergarmentFinishTime && now >= data.undergarmentFinishTime && !data.undergarmentNotified);

        if (!costumeExpired && !underExpired) continue;

        if (costumeExpired) data.costumeNotified = true;
        if (underExpired) data.undergarmentNotified = true;
        changed = true;

        const expiredTitles = [];
        if (costumeExpired) expiredTitles.push('👘 **Costume**');
        if (underExpired) expiredTitles.push('🩲 **Undergarment**');

        const statusLines = [];
        if (data.costumeFinishTime) {
            const cTs = Math.floor(data.costumeFinishTime / 1000);
            statusLines.push(now >= data.costumeFinishTime ? '• **Costume:** ⚠️ Expirado!' : `• **Costume:** expira <t:${cTs}:R> (<t:${cTs}:f>)`);
        }
        if (data.undergarmentFinishTime) {
            const uTs = Math.floor(data.undergarmentFinishTime / 1000);
            statusLines.push(now >= data.undergarmentFinishTime ? '• **Undergarment:** ⚠️ Expirado!' : `• **Undergarment:** expira <t:${uTs}:R> (<t:${uTs}:f>)`);
        }

        await sendDMByUserId(userId, {
            content:
                `⏰ **Alerta de Expiração!**\n` +
                `Seu ${expiredTitles.join(' e ')} expirou!\n\n` +
                `${statusLines.join('\n')}\n\n` +
                `Quando lavar, clique na opção correspondente abaixo para renovar o timer por **30 dias**:`,
            components: [buildWardrobeWashButtons()]
        });
    }

    if (changed) {
        await saveData();
    }

    if (shouldResendPanel) {
        await updatePanel(true);
    } else if (changed) {
        await updatePanel(false);
    }
}

setInterval(() => {
    runChecks().catch(err => console.error('Erro no loop periódico:', err));
}, CHECK_INTERVAL_MS);

// ===== EVENTO READY =====
client.once('ready', async () => {
    console.log(`Bot logado como ${client.user.tag}`);
    await loadData();
    advanceFreedichCycle(Date.now());
    await saveData();
    await updatePanel(true);
});

// ===== MENSAGENS =====
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const text = message.content.trim();

    if (text === '!painel' && message.guild) {
        if (message.deletable) await message.delete().catch(() => null);
        await sendNewPanel(message.channel);
        return;
    }

    if (text === '!packs' && message.guild) {
        if (message.deletable) await message.delete().catch(() => null);
        if (message.author.id !== ELU_USER_ID) return;

        if (state.packsMenuMessageId) {
            const oldMenu = await message.channel.messages.fetch(state.packsMenuMessageId).catch(() => null);
            if (oldMenu) await oldMenu.delete().catch(() => null);
            state.packsMenuMessageId = null;
        }

        const sentMenu = await message.channel.send(buildPacksConfigPayload());
        state.packsMenuMessageId = sentMenu.id;
        await saveData();

        const menuId = sentMenu.id;
        setTimeout(async () => {
            if (state.packsMenuMessageId === menuId) {
                state.packsMenuMessageId = null;
                await saveData();
                await sentMenu.delete().catch(() => null);
                await updatePanel(true);
            }
        }, 15 * 60 * 1000);
        return;
    }

    if (state.panelChannelId === message.channel.id) {
        setTimeout(() => updatePanel(false), 1000);
    }
});

// ===== HELPERS DE INTERAÇÃO =====
function requireElu(interaction) {
    if (interaction.user.id !== ELU_USER_ID) {
        replyEphemeral(interaction, {
            content: '🚫 Apenas o EluDelu pode usar a configuração de Packs.'
        }).catch(() => null);
        return false;
    }
    return true;
}

async function handlePacksReplant(interaction) {
    const managerMember = state.packs.manager ? getMember(state.packs.manager) : null;
    const isDesignatedManager = Boolean(managerMember && managerMember.id === interaction.user.id);

    if (!isDesignatedManager && interaction.user.id !== ELU_USER_ID && !isAdmin(interaction)) {
        return replyEphemeral(interaction, {
            content: `🚫 Apenas o(a) Gestor(a) (${managerMember ? managerMember.name : 'não definido'}) pode clicar em **Replantei**!`
        });
    }

    state.packs.finishTime = Date.now() + THREE_DAYS_MS;
    state.packs.notified = false;
    await saveData();

    const ts = Math.floor(state.packs.finishTime / 1000);

    if (!interaction.guild && interaction.message?.author?.id === client.user.id) {
        await interaction.update({
            content: `🌱 **Packs replantados!** Timer resetado para **3 dias** (<t:${ts}:f> — <t:${ts}:R>).`,
            components: []
        });
    } else {
        await replyEphemeral(interaction, {
            content: `🌱 **Packs replantados!** Timer resetado para **3 dias** (<t:${ts}:f> — <t:${ts}:R>).`
        });
    }

    for (const key of state.packs.recipients) {
        const m = getMember(key);
        if (!m || !m.id || m.id === interaction.user.id) continue;
        await sendDMByUserId(m.id, {
            content: `🌱 **${interaction.user.username}** clicou em **Replantei**! Os próximos packs ficarão prontos em **3 dias** (<t:${ts}:f> — <t:${ts}:R>).`
        });
    }
}

async function handleWardrobeWash(interaction, mode) {
    const userId = interaction.user.id;
    const existing = state.wardrobe[userId] || {
        name: interaction.user.username,
        costumeFinishTime: null,
        costumeNotified: false,
        undergarmentFinishTime: null,
        undergarmentNotified: false
    };
    existing.name = interaction.user.username;

    const newFinish = Date.now() + THIRTY_DAYS_MS;
    const newTs = Math.floor(newFinish / 1000);
    let msg = '';

    if (mode === 'both') {
        existing.costumeFinishTime = newFinish;
        existing.costumeNotified = false;
        existing.undergarmentFinishTime = newFinish;
        existing.undergarmentNotified = false;
        msg = `🧼 **Costume e Undergarment lavados!** Ambos renovados para **30 dias** (<t:${newTs}:f> — <t:${newTs}:R>).`;
    } else if (mode === 'costume') {
        existing.costumeFinishTime = newFinish;
        existing.costumeNotified = false;
        const underInfo = existing.undergarmentFinishTime
            ? `\n🩲 Seu **Undergarment** continua para <t:${Math.floor(existing.undergarmentFinishTime / 1000)}:R>.`
            : '';
        msg = `👘 **Apenas Costume lavado!** Renovado para **30 dias** (<t:${newTs}:f> — <t:${newTs}:R>).${underInfo}`;
    } else if (mode === 'under') {
        existing.undergarmentFinishTime = newFinish;
        existing.undergarmentNotified = false;
        const costumeInfo = existing.costumeFinishTime
            ? `\n👘 Seu **Costume** continua para <t:${Math.floor(existing.costumeFinishTime / 1000)}:R>.`
            : '';
        msg = `🩲 **Apenas Undergarment lavado!** Renovado para **30 dias** (<t:${newTs}:f> — <t:${newTs}:R>).${costumeInfo}`;
    }

    state.wardrobe[userId] = existing;
    await saveData();

    if (!interaction.guild && interaction.message?.author?.id === client.user.id) {
        await interaction.update({ content: msg, components: [] });
    } else {
        await replyEphemeral(interaction, { content: msg });
    }
}

// ===== INTERAÇÕES =====
client.on('interactionCreate', async (interaction) => {
    try {
        // ---- BOTÕES ----
        if (interaction.isButton()) {
            const { customId } = interaction;

            // 1. Freedich: MIA
            if (customId === 'freedich_mia') {
                state.freedich.status = 'MIA';
                state.freedich.nextChangeTime = null;
                state.freedich.lastActionTime = null;

                if (state.panelChannelId) {
                    const ch = await client.channels.fetch(state.panelChannelId).catch(() => null);
                    if (ch) await deleteLastAlertMessage(ch);
                }

                await saveData();
                await replyEphemeral(interaction, {
                    content: '⚪ Timer do Freedich marcado como **MIA**. O botão **➕ Adicionar Timer** foi liberado!'
                });
                await updatePanel(true);
                return;
            }

            // 1. Freedich: Adicionar Timer
            if (customId === 'freedich_add_timer') {
                const modal = new ModalBuilder()
                    .setCustomId('modal_freedich_timer')
                    .setTitle('Freedich Gold Trader (Brasília)');

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_hora_entrou')
                            .setLabel('Hora que ENTROU na ilha (HH:MM Brasília)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                            .setPlaceholder('Ex: 10:30 (deixe vazio se preencheu abaixo)')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_hora_saiu')
                            .setLabel('Hora que SAIU da ilha (HH:MM Brasília)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                            .setPlaceholder('Ex: 08:30 (deixe vazio se preencheu acima)')
                    )
                );

                await interaction.showModal(modal);
                return;
            }

            // 2. Packs: Replantei (apenas no PV do Gestor)
            if (customId === 'packs_replant') {
                await handlePacksReplant(interaction);
                return;
            }

            // 2. Packs (!packs exclusivo EluDelu)
            if (customId === 'packs_set_time') {
                if (!requireElu(interaction)) return;
                const modal = new ModalBuilder()
                    .setCustomId('modal_packs_time')
                    .setTitle('Tempo dos Packs');

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_packs_dhm')
                            .setLabel('Duração p/ ficar pronto: (dias)(horas)(minutos)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setPlaceholder('Ex: (3)(0)(0) ou 2 14 30 ou 2d 14h 30m')
                    )
                );

                await interaction.showModal(modal);
                return;
            }

            if (customId === 'packs_add_member') {
                if (!requireElu(interaction)) return;
                const modal = new ModalBuilder()
                    .setCustomId('modal_packs_add_member')
                    .setTitle('Adicionar / Editar Pessoa (Packs)');

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_member_name')
                            .setLabel('Nome da Pessoa')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setPlaceholder('Ex: EluDelu')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_member_id')
                            .setLabel('ID do Discord da Pessoa')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setPlaceholder('Ex: 210789096837218306')
                    )
                );

                await interaction.showModal(modal);
                return;
            }

            if (customId === 'packs_remove_member') {
                if (!requireElu(interaction)) return;
                const entries = Object.entries(state.members);
                if (entries.length === 0) {
                    return replyEphemeral(interaction, { content: '⚠️ Nenhuma pessoa cadastrada.' });
                }

                const options = entries.slice(0, 25).map(([key, m]) => ({
                    label: m.name,
                    description: `ID: ${m.id}`,
                    value: key
                }));

                const select = new StringSelectMenuBuilder()
                    .setCustomId('packs_select_remove_member')
                    .setPlaceholder('Selecione quem deseja remover')
                    .addOptions(options);

                await replyEphemeral(interaction, {
                    content: '🗑️ Selecione a pessoa para remover da lista:',
                    components: [new ActionRowBuilder().addComponents(select)]
                });
                return;
            }

            if (customId === 'packs_close_menu') {
                if (!requireElu(interaction)) return;
                state.packsMenuMessageId = null;
                await saveData();
                await interaction.message.delete().catch(() => null);
                await updatePanel(true);
                return;
            }

            // 3. Wardrobe: Menu Ephemeral individual (ao lado de Adicionar Timer)
            if (customId === 'wardrobe_menu') {
                await replyEphemeral(interaction, buildWardrobeMenuPayload(interaction.user.id));
                return;
            }

            if (customId === 'wardrobe_open_modal') {
                const modal = new ModalBuilder()
                    .setCustomId('modal_wardrobe_time')
                    .setTitle('Costume & Undergarment');

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_costume_dhm')
                            .setLabel('Costume: (dias)(horas)(minutos)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                            .setPlaceholder('Ex: (29)(12)(30) ou 29 12 30 (vazio = não alterar)')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('input_undergarment_dhm')
                            .setLabel('Undergarment: (dias)(horas)(minutos)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                            .setPlaceholder('Ex: (15)(08)(00) ou 15 8 0 (vazio = não alterar)')
                    )
                );

                await interaction.showModal(modal);
                return;
            }

            if (customId === 'wardrobe_wash_both') {
                await handleWardrobeWash(interaction, 'both');
                return;
            }
            if (customId === 'wardrobe_wash_costume') {
                await handleWardrobeWash(interaction, 'costume');
                return;
            }
            if (customId === 'wardrobe_wash_under') {
                await handleWardrobeWash(interaction, 'under');
                return;
            }

            if (customId === 'wardrobe_clear_mine') {
                delete state.wardrobe[interaction.user.id];
                await saveData();
                await interaction.update(
                    buildWardrobeMenuPayload(interaction.user.id, '🗑️ Seus alertas de Costume e Undergarment foram removidos.')
                );
                return;
            }
        }

        // ---- SELECT MENUS ----
        if (interaction.isStringSelectMenu()) {
            const { customId } = interaction;

            if (customId === 'packs_select_recipients') {
                if (!requireElu(interaction)) return;
                state.packs.recipients = interaction.values.filter(k => state.members[k]);
                await saveData();
                await interaction.update(buildPacksConfigPayload());
                return;
            }

            if (customId === 'packs_select_manager') {
                if (!requireElu(interaction)) return;
                const chosen = interaction.values[0];
                if (state.members[chosen]) {
                    state.packs.manager = chosen;
                    await saveData();
                }
                await interaction.update(buildPacksConfigPayload());
                return;
            }

            if (customId === 'packs_select_remove_member') {
                if (!requireElu(interaction)) return;
                const key = interaction.values[0];
                const removedName = state.members[key]?.name || key;
                delete state.members[key];
                state.packs.recipients = state.packs.recipients.filter(k => k !== key);
                if (state.packs.manager === key) {
                    const remainingKeys = Object.keys(state.members);
                    state.packs.manager = remainingKeys[0] || null;
                }
                await saveData();

                if (state.packsMenuMessageId && interaction.channel) {
                    const menuMsg = await interaction.channel.messages.fetch(state.packsMenuMessageId).catch(() => null);
                    if (menuMsg) await menuMsg.edit(buildPacksConfigPayload()).catch(() => null);
                }

                await interaction.update({
                    content: `🗑️ **${removedName}** removido(a) da lista de Packs.`,
                    components: []
                });
                return;
            }
        }

        // ---- MODAIS ----
        if (interaction.isModalSubmit()) {
            const { customId } = interaction;

            // 1. Freedich Timer Modal
            if (customId === 'modal_freedich_timer') {
                const entrouRaw = interaction.fields.getTextInputValue('input_hora_entrou').trim();
                const saiuRaw = interaction.fields.getTextInputValue('input_hora_saiu').trim();

                if ((entrouRaw && saiuRaw) || (!entrouRaw && !saiuRaw)) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ Preencha **apenas um** dos campos (a hora que ENTROU **ou** a hora que SAIU).'
                    });
                }

                const isEntrou = Boolean(entrouRaw);
                const eventTs = parseBrasiliaTimeToday(isEntrou ? entrouRaw : saiuRaw);

                if (!eventTs) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ Horário inválido! Use o formato `HH:MM` no horário de Brasília (ex: `08:30` ou `14:00`).'
                    });
                }

                state.freedich.status = isEntrou ? 'ON' : 'OFF';
                state.freedich.lastActionTime = eventTs;
                state.freedich.nextChangeTime = eventTs + TWO_HOURS_MS;

                advanceFreedichCycle(Date.now());

                if (state.panelChannelId) {
                    const ch = await client.channels.fetch(state.panelChannelId).catch(() => null);
                    if (ch) await deleteLastAlertMessage(ch);
                }

                await saveData();

                const nextTs = state.freedich.nextChangeTime;
                const followingTs = nextTs + TWO_HOURS_MS;
                const nextUnix = Math.floor(nextTs / 1000);
                const followingUnix = Math.floor(followingTs / 1000);
                const statusLabel = state.freedich.status === 'ON' ? '🟢 **ON**' : '🔴 **OFF**';
                const nextAction = state.freedich.status === 'ON' ? 'desativa (OFF)' : 'reativa (ON)';
                const followingAction = state.freedich.status === 'ON' ? 'reativa (ON)' : 'desativa (OFF)';

                await replyEphemeral(interaction, {
                    content:
                        `✅ **Timer do Freedich configurado!**\n` +
                        `Status atual: ${statusLabel}\n` +
                        `Próximo evento: ${nextAction} às <t:${nextUnix}:t> (<t:${nextUnix}:R>)\n` +
                        `Depois disso: ${followingAction} às <t:${followingUnix}:t> (<t:${followingUnix}:R>)`
                });

                await updatePanel(true);
                return;
            }

            // 2. Packs Time Modal (!packs exclusivo EluDelu)
            if (customId === 'modal_packs_time') {
                if (!requireElu(interaction)) return;
                const rawDhm = interaction.fields.getTextInputValue('input_packs_dhm').trim();
                const ms = parseDHM(rawDhm);

                if (!ms) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ Formato inválido! Use `(dias)(horas)(minutos)`, ex: `(3)(0)(0)`, `2 14 30` ou `2d 14h 30m`.'
                    });
                }

                state.packs.finishTime = Date.now() + ms;
                state.packs.notified = false;
                await saveData();

                if (state.packsMenuMessageId && interaction.channel) {
                    const menuMsg = await interaction.channel.messages.fetch(state.packsMenuMessageId).catch(() => null);
                    if (menuMsg) await menuMsg.edit(buildPacksConfigPayload()).catch(() => null);
                }

                const ts = Math.floor(state.packs.finishTime / 1000);
                await replyEphemeral(interaction, {
                    content: `⏱️ **Timer dos Packs definido!** Falta **${formatDuration(ms)}** — prontos em <t:${ts}:f> (<t:${ts}:R>).`
                });
                return;
            }

            // 2. Packs Add/Edit Member Modal (!packs exclusivo EluDelu)
            if (customId === 'modal_packs_add_member') {
                if (!requireElu(interaction)) return;
                const name = interaction.fields.getTextInputValue('input_member_name').trim();
                const rawId = interaction.fields.getTextInputValue('input_member_id').trim();
                const idMatch = rawId.match(/\d{17,20}/);

                if (!idMatch) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ ID do Discord inválido! Cole o ID numérico do usuário (17 a 20 dígitos).'
                    });
                }

                const discordId = idMatch[0];
                let existingKey = Object.keys(state.members).find(k => state.members[k].id === discordId);
                if (!existingKey) {
                    existingKey = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `user_${discordId.slice(-4)}`;
                }

                state.members[existingKey] = { name, id: discordId };
                await saveData();

                if (state.packsMenuMessageId && interaction.channel) {
                    const menuMsg = await interaction.channel.messages.fetch(state.packsMenuMessageId).catch(() => null);
                    if (menuMsg) await menuMsg.edit(buildPacksConfigPayload()).catch(() => null);
                }

                await replyEphemeral(interaction, {
                    content: `✅ Pessoa **${name}** (<@${discordId}>) salva! Agora você pode selecioná-la nos menus acima.`
                });
                return;
            }

            // 3. Wardrobe Time Modal
            if (customId === 'modal_wardrobe_time') {
                const costumeRaw = interaction.fields.getTextInputValue('input_costume_dhm').trim();
                const underRaw = interaction.fields.getTextInputValue('input_undergarment_dhm').trim();

                if (!costumeRaw && !underRaw) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ Preencha pelo menos um campo (**Costume** ou **Undergarment**).'
                    });
                }

                const costumeMs = costumeRaw ? parseDHM(costumeRaw) : null;
                const underMs = underRaw ? parseDHM(underRaw) : null;

                if (costumeRaw && !costumeMs) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ Tempo do **Costume** inválido! Use `(dias)(horas)(minutos)`, ex: `(29)(12)(30)` ou `29 12 30`.'
                    });
                }
                if (underRaw && !underMs) {
                    return replyEphemeral(interaction, {
                        content: '⚠️ Tempo do **Undergarment** inválido! Use `(dias)(horas)(minutos)`, ex: `(15)(08)(00)` ou `15 8 0`.'
                    });
                }

                const userId = interaction.user.id;
                const entry = state.wardrobe[userId] || {
                    name: interaction.user.username,
                    costumeFinishTime: null,
                    costumeNotified: false,
                    undergarmentFinishTime: null,
                    undergarmentNotified: false
                };
                entry.name = interaction.user.username;

                const now = Date.now();
                const summaryLines = [];

                if (costumeMs) {
                    entry.costumeFinishTime = now + costumeMs;
                    entry.costumeNotified = false;
                    const cTs = Math.floor(entry.costumeFinishTime / 1000);
                    summaryLines.push(`👘 **Costume:** expira em **${formatDuration(costumeMs)}** (<t:${cTs}:f> — <t:${cTs}:R>)`);
                }
                if (underMs) {
                    entry.undergarmentFinishTime = now + underMs;
                    entry.undergarmentNotified = false;
                    const uTs = Math.floor(entry.undergarmentFinishTime / 1000);
                    summaryLines.push(`🩲 **Undergarment:** expira em **${formatDuration(underMs)}** (<t:${uTs}:f> — <t:${uTs}:R>)`);
                }

                state.wardrobe[userId] = entry;
                await saveData();

                await replyEphemeral(interaction, {
                    content:
                        `✅ **Timers salvos!**\n${summaryLines.join('\n')}\n\n` +
                        `📩 Quando expirar, você receberá um aviso no seu **PV** com os botões de lavar (deixe as DMs do servidor liberadas).`
                });
                return;
            }
        }
    } catch (err) {
        console.error('Erro ao processar interação:', err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await replyEphemeral(interaction, { content: '⚠️ Ocorreu um erro ao processar sua ação.' }).catch(() => null);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
