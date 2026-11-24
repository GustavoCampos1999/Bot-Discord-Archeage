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

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || '';
const USE_JSONBIN = JSONBIN_KEY !== '' && JSONBIN_BIN_ID !== '';

// ===== ESTADO PADRÃO =====
const DEFAULT_STATE = {
    panelChannelId: null,
    panelMessageId: null,

    // 1. Freedich Gold Seller (2h ON / 2h OFF ou MIA)
    freedich: {
        status: 'MIA',        // 'ON' | 'OFF' | 'MIA'
        nextChangeTime: null, // Timestamp em ms da próxima mudança
        lastActionText: null
    },

    // 2. Packs (PV para escolhidos + Gestor(a) com botão Replantei 3 dias)
    packs: {
        finishTime: null,
        notified: false,
        recipients: ['elu', 'trollei', 'tock'],
        manager: 'elu'
    },

    // Membros salvos para seleção nos menus de Packs
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

    const savedPacks = saved.packs && typeof saved.packs === 'object' ? saved.packs : {};
    let recipients = Array.isArray(savedPacks.recipients)
        ? savedPacks.recipients.filter(k => mergedMembers[k])
        : DEFAULT_STATE.packs.recipients.filter(k => mergedMembers[k]);

    let manager = (savedPacks.manager && mergedMembers[savedPacks.manager])
        ? savedPacks.manager
        : (mergedMembers[DEFAULT_STATE.packs.manager] ? DEFAULT_STATE.packs.manager : (memberKeys[0] || null));

    const savedWardrobe = (saved.wardrobe && typeof saved.wardrobe === 'object') ? saved.wardrobe : {};

    state = {
        panelChannelId: saved.panelChannelId || null,
        panelMessageId: saved.panelMessageId || null,
        freedich: {
            status: validStatus,
            nextChangeTime: typeof savedFreedich.nextChangeTime === 'number' ? savedFreedich.nextChangeTime : null,
            lastActionText: savedFreedich.lastActionText || null
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
    if (ms <= 0) return 'Pronto!';
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

function formatBrasiliaHHMM(ts) {
    const d = new Date(ts + BRT_OFFSET_MS);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
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

// ===== MOTOR DE CICLO DO FREEDICH =====
function advanceFreedichCycle(now = Date.now()) {
    const f = state.freedich;
    if (f.status === 'MIA' || !f.nextChangeTime) return [];

    const events = [];
    while (now >= f.nextChangeTime) {
        const changeTs = f.nextChangeTime;
        f.status = f.status === 'ON' ? 'OFF' : 'ON';
        f.nextChangeTime = changeTs + TWO_HOURS_MS;
        f.lastActionText = `${f.status === 'ON' ? 'Entrou' : 'Saiu'} às ${formatBrasiliaHHMM(changeTs)}`;
        events.push({
            status: f.status,
            changedAt: changeTs,
            nextAt: f.nextChangeTime
        });
    }
    return events;
}

// ===== COMPONENTES & EMBEDS DO PAINEL PRINCIPAL =====
function buildFreedichEmbed() {
    const f = state.freedich;
    const embed = new EmbedBuilder().setTitle('🪙 Freedich — Gold Seller (Brasília)');

    if (f.status === 'MIA' || !f.nextChangeTime) {
        embed
            .setColor('#95a5a6')
            .setDescription(
                '**Status:** ⚪ **MIA — Sem Timer** *(Reset de servidor / horário desconhecido)*\n\n' +
                'Clique em **➕ Adicionar Timer** abaixo e informe a hora de Brasília em que o Gold Seller **entrou** ou **saiu** da ilha.'
            );
        return embed;
    }

    const now = Date.now();
    const nextTs = f.nextChangeTime;
    const followingTs = nextTs + TWO_HOURS_MS;
    const nextDiscordTs = Math.floor(nextTs / 1000);
    const followingDiscordTs = Math.floor(followingTs / 1000);

    if (f.status === 'ON') {
        embed
            .setColor('#2ecc71')
            .setDescription(
                `**Status:** 🟢 **GOLD SELLER ON (Na Ilha!)**\n` +
                (f.lastActionText ? `🕒 *Último registro: ${f.lastActionText} (BRT)*\n\n` : '\n') +
                `⛵ **Para SAIR (OFF):** falta **${formatDuration(nextTs - now)}** — às **${formatBrasiliaHHMM(nextTs)}** (<t:${nextDiscordTs}:R>)\n` +
                `🪙 **Para ENTRAR novamente (ON):** falta **${formatDuration(followingTs - now)}** — às **${formatBrasiliaHHMM(followingTs)}** (<t:${followingDiscordTs}:R>)`
            );
    } else {
        embed
            .setColor('#e74c3c')
            .setDescription(
                `**Status:** 🔴 **GOLD SELLER OFF (Fora da Ilha)**\n` +
                (f.lastActionText ? `🕒 *Último registro: ${f.lastActionText} (BRT)*\n\n` : '\n') +
                `🪙 **Para ENTRAR (ON):** falta **${formatDuration(nextTs - now)}** — às **${formatBrasiliaHHMM(nextTs)}** (<t:${nextDiscordTs}:R>)\n` +
                `⛵ **Para SAIR depois (OFF):** falta **${formatDuration(followingTs - now)}** — às **${formatBrasiliaHHMM(followingTs)}** (<t:${followingDiscordTs}:R>)`
            );
    }

    return embed;
}

function buildPacksEmbed() {
    const p = state.packs;
    const embed = new EmbedBuilder().setTitle('🌿 Packs — Alerta no PV & Gestor(a)');
    const now = Date.now();

    let timerLine = '⚪ **Timer:** Sem timer ativo.';
    if (p.finishTime) {
        const ts = Math.floor(p.finishTime / 1000);
        if (now >= p.finishTime) {
            embed.setColor('#e74c3c');
            timerLine = `✅ **PACKS PRONTOS PARA COLHER!** (<t:${ts}:R>)`;
        } else {
            embed.setColor('#2ecc71');
            timerLine = `⏳ **Falta:** **${formatDuration(p.finishTime - now)}** (<t:${ts}:R>)\n📅 **Prontos em:** <t:${ts}:f>`;
        }
    } else {
        embed.setColor('#3498db');
    }

    const managerText = p.manager ? getMention(p.manager) : '*Não definido*';
    const recipientsText = p.recipients.length > 0
        ? p.recipients.map(k => getMention(k)).join(', ')
        : '*Ninguém selecionado*';

    embed.setDescription(
        `${timerLine}\n\n` +
        `👑 **Gestor(a) (botão Replantei 3d):** ${managerText}\n` +
        `📩 **Recebem alerta no PV:** ${recipientsText}`
    );

    return embed;
}

function buildWardrobeEmbed() {
    const entries = Object.entries(state.wardrobe);
    const activeLines = [];
    const now = Date.now();

    for (const [userId, data] of entries) {
        const parts = [];
        if (data.costumeFinishTime) {
            const cTs = Math.floor(data.costumeFinishTime / 1000);
            parts.push(now >= data.costumeFinishTime ? 'Costume: **EXPIRADO**' : `Costume: <t:${cTs}:R>`);
        }
        if (data.undergarmentFinishTime) {
            const uTs = Math.floor(data.undergarmentFinishTime / 1000);
            parts.push(now >= data.undergarmentFinishTime ? 'Undergarment: **EXPIRADO**' : `Under: <t:${uTs}:R>`);
        }
        if (parts.length > 0) {
            activeLines.push(`• <@${userId}>: ${parts.join(' | ')}`);
        }
    }

    const preview = activeLines.length > 0
        ? `\n\n**Timers ativos (${activeLines.length}):**\n${activeLines.slice(0, 12).join('\n')}${activeLines.length > 12 ? `\n*...e mais ${activeLines.length - 12}*` : ''}`
        : '\n\n*Nenhum timer configurado ainda — clique abaixo para cadastrar o seu!*';

    return new EmbedBuilder()
        .setTitle('👘 Costume & Undergarment (Aviso no PV — 30 Dias)')
        .setColor('#9b59b6')
        .setDescription(
            'Qualquer pessoa pode cadastrar o tempo restante do seu **Costume** e/ou **Undergarment**.\n' +
            'Quando expirar, o bot avisa no seu **PV** com os botões de lavar (renova por **30 dias**).' +
            preview
        );
}

function buildPanelComponents() {
    const isMia = state.freedich.status === 'MIA' || !state.freedich.nextChangeTime;

    const rowFreedich = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('freedich_mia')
            .setLabel('❓ MIA')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(isMia),
        new ButtonBuilder()
            .setCustomId('freedich_add_timer')
            .setLabel('➕ Adicionar Timer')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!isMia)
    );

    const rowPacks = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('packs_replant')
            .setLabel('🌱 Replantei (3 Dias)')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('packs_set_time')
            .setLabel('⏱️ Definir Tempo Packs')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('packs_menu')
            .setLabel('⚙️ Configurar Packs (PV / Gestor)')
            .setStyle(ButtonStyle.Secondary)
    );

    const rowWardrobe = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('wardrobe_open_modal')
            .setLabel('👘 Configurar Costume / Undergarment')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('wardrobe_my_status')
            .setLabel('🧼 Meu Costume / Lavei (30d)')
            .setStyle(ButtonStyle.Secondary)
    );

    return [rowFreedich, rowPacks, rowWardrobe];
}

function buildPanelPayload() {
    return {
        embeds: [buildFreedichEmbed(), buildPacksEmbed(), buildWardrobeEmbed()],
        components: buildPanelComponents()
    };
}

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
            .setPlaceholder('Escolha a pessoa GESTORA (botão Replantei)')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(managerOptions);

        rows.push(
            new ActionRowBuilder().addComponents(selectRecipients),
            new ActionRowBuilder().addComponents(selectManager)
        );
    }

    const memberActionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('packs_add_member')
            .setLabel('➕ Adicionar / Editar Pessoa')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('packs_remove_member')
            .setLabel('🗑️ Remover Pessoa')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(memberEntries.length === 0)
    );
    rows.push(memberActionRow);

    const managerText = state.packs.manager ? getMention(state.packs.manager) : '*Não definido*';
    const recipientsText = state.packs.recipients.length > 0
        ? state.packs.recipients.map(k => getMention(k)).join(', ')
        : '*Ninguém*';

    return {
        content:
            `**⚙️ Configuração de Packs (salvo automaticamente)**\n` +
            `👑 **Gestor(a):** ${managerText}\n` +
            `📩 **Recebem alerta no PV:** ${recipientsText}`,
        components: rows,
        ephemeral: true
    };
}

// ===== GESTÃO DO PAINEL COMO ÚLTIMA MENSAGEM =====
async function sendNewPanel(channel) {
    const sentMessage = await channel.send(buildPanelPayload());

    if (state.panelMessageId && state.panelChannelId === channel.id && state.panelMessageId !== sentMessage.id) {
        try {
            const oldMsg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => null);
        } catch (e) {}
    }

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

    // 1. Freedich Gold Seller (2h ON / 2h OFF)
    const freedichEvents = advanceFreedichCycle(now);
    if (freedichEvents.length > 0) {
        changed = true;
        if (state.panelChannelId) {
            const channel = await client.channels.fetch(state.panelChannelId).catch(() => null);
            if (channel) {
                for (const ev of freedichEvents) {
                    const horaEvento = formatBrasiliaHHMM(ev.changedAt);
                    const horaProximo = formatBrasiliaHHMM(ev.nextAt);
                    const nextTs = Math.floor(ev.nextAt / 1000);

                    if (ev.status === 'ON') {
                        await channel.send(
                            `🪙 **FREEDICH GOLD SELLER ON!**\n` +
                            `O Merchant de Gold **ENTROU** na ilha às **${horaEvento}** (Brasília)!\n` +
                            `Ele fica ativo por 2h e sai às **${horaProximo}** (<t:${nextTs}:R>).`
                        ).catch(() => null);
                    } else {
                        await channel.send(
                            `⛵ **FREEDICH GOLD SELLER OFF!**\n` +
                            `O Merchant de Gold **SAIU** da ilha às **${horaEvento}** (Brasília)!\n` +
                            `Ele fica fora por 2h e volta às **${horaProximo}** (<t:${nextTs}:R>).`
                        ).catch(() => null);
                    }
                }
                shouldResendPanel = true;
            }
        }
    }

    // 2. Packs prontos (alerta no PV + botão Replantei para a gestora)
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
    } else if (changed || state.freedich.status !== 'MIA' || state.packs.finishTime) {
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

    if (message.content.trim() === '!painel' && message.guild) {
        await sendNewPanel(message.channel);
        if (message.deletable) await message.delete().catch(() => null);
        return;
    }

    if (state.panelChannelId === message.channel.id) {
        setTimeout(() => updatePanel(false), 1000);
    }
});

// ===== HELPERS DE INTERAÇÃO =====
async function handlePacksReplant(interaction) {
    const managerMember = state.packs.manager ? getMember(state.packs.manager) : null;
    const isDesignatedManager = Boolean(managerMember && managerMember.id === interaction.user.id);

    if (!isDesignatedManager && !isAdmin(interaction)) {
        return interaction.reply({
            content: `🚫 Apenas o(a) Gestor(a) (${managerMember ? managerMember.name : 'não definido'}) ou Administrador pode clicar em **Replantei**!`,
            ephemeral: true
        });
    }

    state.packs.finishTime = Date.now() + THREE_DAYS_MS;
    state.packs.notified = false;
    await saveData();

    const ts = Math.floor(state.packs.finishTime / 1000);

    if (interaction.guild) {
        await interaction.reply({
            content: `🌱 **Packs replantados!** Novo timer iniciado para **3 dias** (prontos em <t:${ts}:f>).`,
            ephemeral: true
        });
    } else {
        await interaction.update({
            content: `🌱 **Packs replantados!** Timer resetado para **3 dias** (prontos em <t:${ts}:f>).`,
            components: []
        });
    }

    // Notifica os destinatários no PV que os packs foram replantados
    for (const key of state.packs.recipients) {
        const m = getMember(key);
        if (!m || !m.id || m.id === interaction.user.id) continue;
        await sendDMByUserId(m.id, {
            content: `🌱 **${interaction.user.username}** clicou em **Replantei**! Os próximos packs ficarão prontos em **3 dias** (<t:${ts}:f>).`
        });
    }

    await updatePanel(true);
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
        msg = `🧼 **Costume e Undergarment lavados!** Ambos renovados para **30 dias** (<t:${newTs}:f>).`;
    } else if (mode === 'costume') {
        existing.costumeFinishTime = newFinish;
        existing.costumeNotified = false;
        const underInfo = existing.undergarmentFinishTime
            ? `\n🩲 Seu **Undergarment** continua para <t:${Math.floor(existing.undergarmentFinishTime / 1000)}:R>.`
            : '';
        msg = `👘 **Apenas Costume lavado!** Renovado para **30 dias** (<t:${newTs}:f>).${underInfo}`;
    } else if (mode === 'under') {
        existing.undergarmentFinishTime = newFinish;
        existing.undergarmentNotified = false;
        const costumeInfo = existing.costumeFinishTime
            ? `\n👘 Seu **Costume** continua para <t:${Math.floor(existing.costumeFinishTime / 1000)}:R>.`
            : '';
        msg = `🩲 **Apenas Undergarment lavado!** Renovado para **30 dias** (<t:${newTs}:f>).${costumeInfo}`;
    }

    state.wardrobe[userId] = existing;
    await saveData();

    if (!interaction.guild && interaction.message?.author?.id === client.user.id) {
        await interaction.update({ content: msg, components: [] });
    } else {
        await interaction.reply({ content: msg, ephemeral: true });
    }

    await updatePanel(false);
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
                state.freedich.lastActionText = null;
                await saveData();
                await interaction.reply({
                    content: '⚪ Timer do Freedich marcado como **MIA**. O botão **➕ Adicionar Timer** foi liberado!',
                    ephemeral: true
                });
                await updatePanel(true);
                return;
            }

            // 1. Freedich: Adicionar Timer
            if (customId === 'freedich_add_timer') {
                const modal = new ModalBuilder()
                    .setCustomId('modal_freedich_timer')
                    .setTitle('Freedich Gold Seller (Horário Brasília)');

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

            // 2. Packs: Replantei
            if (customId === 'packs_replant') {
                await handlePacksReplant(interaction);
                return;
            }

            // 2. Packs: Definir Tempo
            if (customId === 'packs_set_time') {
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

            // 2. Packs: Abrir Menu de Configuração
            if (customId === 'packs_menu') {
                await interaction.reply(buildPacksConfigPayload());
                return;
            }

            // 2. Packs: Adicionar / Editar Pessoa
            if (customId === 'packs_add_member') {
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

            // 2. Packs: Remover Pessoa
            if (customId === 'packs_remove_member') {
                const entries = Object.entries(state.members);
                if (entries.length === 0) {
                    return interaction.reply({ content: '⚠️ Nenhuma pessoa cadastrada.', ephemeral: true });
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

                await interaction.reply({
                    content: '🗑️ Selecione a pessoa para remover da lista:',
                    components: [new ActionRowBuilder().addComponents(select)],
                    ephemeral: true
                });
                return;
            }

            // 3. Wardrobe: Abrir Modal de Cadastro
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

            // 3. Wardrobe: Meu Status / Lavei
            if (customId === 'wardrobe_my_status') {
                const data = state.wardrobe[interaction.user.id];
                const now = Date.now();
                let statusText = 'Você ainda não cadastrou nenhum timer de Costume ou Undergarment.';

                if (data && (data.costumeFinishTime || data.undergarmentFinishTime)) {
                    const lines = [];
                    if (data.costumeFinishTime) {
                        const cTs = Math.floor(data.costumeFinishTime / 1000);
                        lines.push(
                            now >= data.costumeFinishTime
                                ? '👘 **Costume:** ⚠️ Expirado!'
                                : `👘 **Costume:** falta **${formatDuration(data.costumeFinishTime - now)}** (<t:${cTs}:f>)`
                        );
                    } else {
                        lines.push('👘 **Costume:** *não cadastrado*');
                    }

                    if (data.undergarmentFinishTime) {
                        const uTs = Math.floor(data.undergarmentFinishTime / 1000);
                        lines.push(
                            now >= data.undergarmentFinishTime
                                ? '🩲 **Undergarment:** ⚠️ Expirado!'
                                : `🩲 **Undergarment:** falta **${formatDuration(data.undergarmentFinishTime - now)}** (<t:${uTs}:f>)`
                        );
                    } else {
                        lines.push('🩲 **Undergarment:** *não cadastrado*');
                    }
                    statusText = lines.join('\n');
                }

                const clearRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('wardrobe_clear_mine')
                        .setLabel('🗑️ Desativar Meus Alertas')
                        .setStyle(ButtonStyle.Danger)
                );

                await interaction.reply({
                    content: `**🧼 Seus Timers (Costume & Undergarment)**\n\n${statusText}\n\nClique abaixo caso já tenha lavado (renova para **30 dias**):`,
                    components: [buildWardrobeWashButtons(), clearRow],
                    ephemeral: true
                });
                return;
            }

            // 3. Wardrobe: Botões de Lavei (30 dias)
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

            // 3. Wardrobe: Limpar alertas do usuário
            if (customId === 'wardrobe_clear_mine') {
                delete state.wardrobe[interaction.user.id];
                await saveData();
                await interaction.update({
                    content: '🗑️ Seus alertas de Costume e Undergarment foram removidos.',
                    components: []
                });
                await updatePanel(false);
                return;
            }
        }

        // ---- SELECT MENUS ----
        if (interaction.isStringSelectMenu()) {
            const { customId } = interaction;

            if (customId === 'packs_select_recipients') {
                state.packs.recipients = interaction.values.filter(k => state.members[k]);
                await saveData();
                await interaction.update(buildPacksConfigPayload());
                await updatePanel(false);
                return;
            }

            if (customId === 'packs_select_manager') {
                const chosen = interaction.values[0];
                if (state.members[chosen]) {
                    state.packs.manager = chosen;
                    await saveData();
                }
                await interaction.update(buildPacksConfigPayload());
                await updatePanel(false);
                return;
            }

            if (customId === 'packs_select_remove_member') {
                const key = interaction.values[0];
                const removedName = state.members[key]?.name || key;
                delete state.members[key];
                state.packs.recipients = state.packs.recipients.filter(k => k !== key);
                if (state.packs.manager === key) {
                    const remainingKeys = Object.keys(state.members);
                    state.packs.manager = remainingKeys[0] || null;
                }
                await saveData();
                await interaction.update({
                    content: `🗑️ **${removedName}** removido(a) da lista de Packs.`,
                    components: []
                });
                await updatePanel(false);
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
                    return interaction.reply({
                        content: '⚠️ Preencha **apenas um** dos campos (a hora que ENTROU **ou** a hora que SAIU).',
                        ephemeral: true
                    });
                }

                const isEntrou = Boolean(entrouRaw);
                const eventTs = parseBrasiliaTimeToday(isEntrou ? entrouRaw : saiuRaw);

                if (!eventTs) {
                    return interaction.reply({
                        content: '⚠️ Horário inválido! Use o formato `HH:MM` no horário de Brasília (ex: `08:30` ou `14:00`).',
                        ephemeral: true
                    });
                }

                state.freedich.status = isEntrou ? 'ON' : 'OFF';
                state.freedich.nextChangeTime = eventTs + TWO_HOURS_MS;
                state.freedich.lastActionText = `${isEntrou ? 'Entrou' : 'Saiu'} às ${formatBrasiliaHHMM(eventTs)}`;

                // Se já passaram blocos de 2h desde o horário informado, sincroniza com o estado atual
                advanceFreedichCycle(Date.now());
                await saveData();

                const nextTs = state.freedich.nextChangeTime;
                const followingTs = nextTs + TWO_HOURS_MS;
                const statusLabel = state.freedich.status === 'ON' ? '🟢 **ON (Na Ilha)**' : '🔴 **OFF (Fora da Ilha)**';
                const nextAction = state.freedich.status === 'ON' ? 'sai' : 'entra';
                const followingAction = state.freedich.status === 'ON' ? 'entra novamente' : 'sai novamente';

                await interaction.reply({
                    content:
                        `✅ **Timer do Freedich configurado!**\n` +
                        `Estado atual: ${statusLabel}\n` +
                        `Próximo evento: ${nextAction} às **${formatBrasiliaHHMM(nextTs)}** (<t:${Math.floor(nextTs / 1000)}:R>)\n` +
                        `Depois disso: ${followingAction} às **${formatBrasiliaHHMM(followingTs)}**`,
                    ephemeral: true
                });

                await updatePanel(true);
                return;
            }

            // 2. Packs Time Modal
            if (customId === 'modal_packs_time') {
                const rawDhm = interaction.fields.getTextInputValue('input_packs_dhm').trim();
                const ms = parseDHM(rawDhm);

                if (!ms) {
                    return interaction.reply({
                        content: '⚠️ Formato inválido! Use `(dias)(horas)(minutos)`, ex: `(3)(0)(0)`, `2 14 30` ou `2d 14h 30m`.',
                        ephemeral: true
                    });
                }

                state.packs.finishTime = Date.now() + ms;
                state.packs.notified = false;
                await saveData();

                const ts = Math.floor(state.packs.finishTime / 1000);
                await interaction.reply({
                    content: `⏱️ **Timer dos Packs definido!** Falta **${formatDuration(ms)}** (prontos em <t:${ts}:f>).`,
                    ephemeral: true
                });

                await updatePanel(true);
                return;
            }

            // 2. Packs Add/Edit Member Modal
            if (customId === 'modal_packs_add_member') {
                const name = interaction.fields.getTextInputValue('input_member_name').trim();
                const rawId = interaction.fields.getTextInputValue('input_member_id').trim();
                const idMatch = rawId.match(/\d{17,20}/);

                if (!idMatch) {
                    return interaction.reply({
                        content: '⚠️ ID do Discord inválido! Cole o ID numérico do usuário (17 a 20 dígitos).',
                        ephemeral: true
                    });
                }

                const discordId = idMatch[0];
                let existingKey = Object.keys(state.members).find(k => state.members[k].id === discordId);
                if (!existingKey) {
                    existingKey = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `user_${discordId.slice(-4)}`;
                }

                state.members[existingKey] = { name, id: discordId };
                await saveData();

                await interaction.reply({
                    content: `✅ Pessoa **${name}** (<@${discordId}>) salva! Agora você pode selecioná-la no menu ⚙️ Configurar Packs.`,
                    ephemeral: true
                });
                await updatePanel(false);
                return;
            }

            // 3. Wardrobe Time Modal
            if (customId === 'modal_wardrobe_time') {
                const costumeRaw = interaction.fields.getTextInputValue('input_costume_dhm').trim();
                const underRaw = interaction.fields.getTextInputValue('input_undergarment_dhm').trim();

                if (!costumeRaw && !underRaw) {
                    return interaction.reply({
                        content: '⚠️ Preencha pelo menos um campo (**Costume** ou **Undergarment**).',
                        ephemeral: true
                    });
                }

                const costumeMs = costumeRaw ? parseDHM(costumeRaw) : null;
                const underMs = underRaw ? parseDHM(underRaw) : null;

                if (costumeRaw && !costumeMs) {
                    return interaction.reply({
                        content: '⚠️ Tempo do **Costume** inválido! Use `(dias)(horas)(minutos)`, ex: `(29)(12)(30)` ou `29 12 30`.',
                        ephemeral: true
                    });
                }
                if (underRaw && !underMs) {
                    return interaction.reply({
                        content: '⚠️ Tempo do **Undergarment** inválido! Use `(dias)(horas)(minutos)`, ex: `(15)(08)(00)` ou `15 8 0`.',
                        ephemeral: true
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
                    summaryLines.push(`👘 **Costume:** expira em **${formatDuration(costumeMs)}** (<t:${cTs}:f>)`);
                }
                if (underMs) {
                    entry.undergarmentFinishTime = now + underMs;
                    entry.undergarmentNotified = false;
                    const uTs = Math.floor(entry.undergarmentFinishTime / 1000);
                    summaryLines.push(`🩲 **Undergarment:** expira em **${formatDuration(underMs)}** (<t:${uTs}:f>)`);
                }

                state.wardrobe[userId] = entry;
                await saveData();

                const dmSent = await sendDMByUserId(userId, {
                    content:
                        `✅ **Alerta cadastrado com sucesso!**\n` +
                        `${summaryLines.join('\n')}\n\n` +
                        `Vou te avisar aqui no PV quando expirar. Se quiser marcar que já lavou antes (renova p/ 30 dias), use os botões abaixo:`,
                    components: [buildWardrobeWashButtons()]
                });

                const dmWarning = dmSent
                    ? '📩 Também te enviei uma confirmação no PV!'
                    : '⚠️ Não consegui enviar DM para você — verifique se suas **Mensagens Diretas do servidor** estão liberadas para receber o alerta quando expirar!';

                await interaction.reply({
                    content: `✅ **Timers salvos!**\n${summaryLines.join('\n')}\n\n${dmWarning}`,
                    ephemeral: true
                });

                await updatePanel(false);
                return;
            }
        }
    } catch (err) {
        console.error('Erro ao processar interação:', err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(() => null);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
