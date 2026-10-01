const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

const app = express();
app.get('/', (req, res) => res.send('Bot de Packs do ArcheAge está online!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor web rodando na porta ${PORT}`));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const DATA_FILE = path.join(__dirname, 'data.json');
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 60 * 1000;

// Estado padrão — só é usado se data.json não existir
const DEFAULT_STATE = {
    sequence: ['elu', 'trollei', 'elu', 'tock'],
    cycleIndex: 0,
    rotation: 0,
    finishTime: null,
    notified: false,
    panelMessageId: null,
    panelChannelId: null,
    rolePacksId: null,
    // members: { chave: { name: 'NickDisplay', id: 'DISCORD_ID' } }
    members: {
        elu:     { name: 'EluDelu',   id: '210789096837218306' },
        trollei: { name: 'Trollei',   id: '372538969805553664' },
        tock:    { name: 'TockTock',  id: '467871652517249034' },
        tonelada:{ name: 'Tonelada',  id: '237228450455224321' }
    }
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            // Mescla campos de ciclo/rotação, mas PRESERVA members do arquivo salvo
            state = {
                ...state,
                ...saved,
                // Garante que members nunca seja substituído pelo padrão se já existir no arquivo
                members: (saved.members && Object.keys(saved.members).length > 0)
                    ? saved.members
                    : state.members
            };
            if (!state.sequence || state.sequence.length !== 4) {
                state.sequence = DEFAULT_STATE.sequence;
            }
        } catch (err) {
            console.error('Erro ao ler data.json:', err);
        }
    } else {
        // Primeira vez — salva as IDs padrão
        saveData();
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function formatTimeLeft(ms) {
    if (ms <= 0) return "Pronto!";
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    return `${days}d ${hours}h ${minutes}m`;
}

function getMember(key) {
    return state.members[key] || { name: key, id: '' };
}

function getMention(key) {
    const m = getMember(key);
    if (m.id && m.id.trim() !== '') return `<@${m.id}>`;
    return `**${m.name}**`;
}

function getDisplayName(key) {
    return getMember(key).name || key;
}

function getRoleMention() {
    if (state.rolePacksId && state.rolePacksId.trim() !== '') {
        return `<@&${state.rolePacksId.replace(/[<@&>]/g, '')}>`;
    }
    return '';
}

async function sendDM(key, messageText) {
    const m = getMember(key);
    if (!m.id || m.id.trim() === '') return;
    try {
        const user = await client.users.fetch(m.id).catch(() => null);
        if (user) await user.send(messageText).catch(() => null);
    } catch (err) {}
}

// Mensagem que vai no privado do PRÓXIMO da fila quando o current planta a 2ª rotação
function getMsgAvisoProximo(nomeAtual) {
    return [
        `🚨 Fala! O **${nomeAtual}** acabou de plantar a última rotação dele — em ~3 dias ele colhe e **já deixa seus packs no terreno**. Você já recebe a primeira rotação feita!`,
        ``,
        `📋 **Lembra do lembrete:**`,
        `> São **79 packs** por rotação (158 nas 2 que você vai colher)`,
        `> O aluguel da semana (suas 2 rotações) é **3.500 gold** — manda pro EluDelu!`,
        `> Temos **4 terrenos**: 1 Treehouse + 3 24x24 — confere as loc no **#land-share**`,
        ``,
        `🧱 **Materiais p/ 79 packs / 158 packs:**`,
        `\`\`\``,
        `Multi-Purpose Aging Larder  79  / 158`,
        `  Royal Seed                40  /  79`,
        `  Lumber                   395  / 790`,
        `  Stone Brick              395  / 790`,
        `  Iron Ingot               395  / 790`,
        ``,
        `Pack de Queijo:`,
        `  Lemon   1.170 / 2.340`,
        `  Milk    1.950 / 3.900`,
        ``,
        `Pack de Mel:`,
        `  Honey     160 /   320`,
        `  Haybale   800 / 1.600`,
        `\`\`\``,
        `Boa sorte! 🌿`
    ].join('\n');
}

function getMemberOptions(placeholder_prefix = '') {
    return Object.entries(state.members).map(([key, m]) => ({
        label: `${placeholder_prefix}${m.name}`,
        value: key
    }));
}

function getConfigComponents() {
    const memberOptions = getMemberOptions();
    const components = [];
    for (let i = 0; i < 4; i++) {
        const currentVal = state.sequence[i];
        const options = memberOptions.map(o => ({ ...o, default: o.value === currentVal }));
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`set_cycle_${i}`)
            .setPlaceholder(`Passo ${i + 1}`)
            .addOptions(options);
        components.push(new ActionRowBuilder().addComponents(menu));
    }
    return components;
}

function buildPanelEmbed() {
    const embed = new EmbedBuilder().setTitle('🌿 Rotação Automática de Packs').setColor('#2ecc71');
    const currentKey = state.sequence[state.cycleIndex];
    const nextKey = state.sequence[(state.cycleIndex + 1) % 4];

    if (state.rotation === 0) {
        embed.setDescription(`O terreno está **LIVRE**.\n\nA vez de plantar é de: ${getMention(currentKey)}`);
        embed.setColor('#3498db');
    } else {
        const timestamp = Math.floor(state.finishTime / 1000);
        let statusText = '';
        if (Date.now() >= state.finishTime) {
            if (state.rotation === 1) {
                statusText = `✅ **PRONTOS PARA COLHER (1/2)!**\nColha os packs e replante para a sua 2ª colheita.`;
            } else {
                statusText = `✅ **PRONTOS PARA COLHER (2/2)!**\nColha os seus últimos packs e **JÁ REPLANTE** para o próximo (${getDisplayName(nextKey)}).`;
            }
            embed.setColor('#e74c3c');
        } else {
            const timeLeft = formatTimeLeft(state.finishTime - Date.now());
            statusText = `⏳ **Tempo restante exato:** ${timeLeft}\nFicam prontos em: <t:${timestamp}:R>\n(Data exata: <t:${timestamp}:f>)`;
        }
        const proxAviso = `\n\n👉 **Próximo da vez:** ${getMention(nextKey)}`;
        embed.setDescription(`**Plantador Atual:** ${getMention(currentKey)}\n**Rotação:** ${state.rotation} de 2\n\n${statusText}${proxAviso}`);
    }
    return embed;
}

function buildPanelButtons() {
    const currentKey = state.sequence[state.cycleIndex];
    const nextKey = state.sequence[(state.cycleIndex + 1) % 4];
    const rowButtons = new ActionRowBuilder();
    const btnPlant = new ButtonBuilder().setCustomId('btn_plantar');

    if (state.rotation === 0) {
        btnPlant.setLabel(`Plantei Packs (Sou o ${getDisplayName(currentKey)})`).setStyle(ButtonStyle.Success);
    } else if (state.rotation === 1) {
        if (Date.now() < state.finishTime) {
            btnPlant.setLabel('Aguardando 1ª Colheita...').setStyle(ButtonStyle.Secondary).setDisabled(true);
        } else {
            btnPlant.setLabel('Colhi e Re-plantei (Ir p/ 2/2)').setStyle(ButtonStyle.Success);
        }
    } else if (state.rotation === 2) {
        if (Date.now() < state.finishTime) {
            btnPlant.setLabel('Aguardando 2ª Colheita...').setStyle(ButtonStyle.Secondary).setDisabled(true);
        } else {
            btnPlant.setLabel(`Colhi Tudo e Plantei p/ ${getDisplayName(nextKey)}`).setStyle(ButtonStyle.Primary);
        }
    }

    rowButtons.addComponents(
        btnPlant,
        new ButtonBuilder().setCustomId('btn_mudar_vez').setLabel('Trocar Plantador Atual').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_admin').setLabel('🛠️ Admin').setStyle(ButtonStyle.Danger)
    );
    return rowButtons;
}

async function sendNewPanel(channel) {
    const sentMessage = await channel.send({ embeds: [buildPanelEmbed()], components: [buildPanelButtons()] });

    if (state.panelMessageId && state.panelChannelId === channel.id) {
        try {
            const oldMsg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
            if (oldMsg) await oldMsg.delete();
        } catch (e) {}
    }

    state.panelChannelId = sentMessage.channel.id;
    state.panelMessageId = sentMessage.id;
    saveData();
}

async function updatePanel(forceResend = false) {
    if (!state.panelChannelId) return;
    try {
        const channel = await client.channels.fetch(state.panelChannelId).catch(() => null);
        if (!channel) return;

        let shouldResend = forceResend;
        if (!shouldResend) {
            const lastMessages = await channel.messages.fetch({ limit: 1 });
            const lastMsg = lastMessages.first();
            if (lastMsg && lastMsg.id !== state.panelMessageId) shouldResend = true;
        }

        if (shouldResend) { await sendNewPanel(channel); return; }

        const message = await channel.messages.fetch(state.panelMessageId).catch(() => null);
        if (!message) { await sendNewPanel(channel); return; }

        await message.edit({ embeds: [buildPanelEmbed()], components: [buildPanelButtons()] });
    } catch (error) {
        console.error('Erro ao atualizar o painel:', error);
    }
}

// ===== TIMER =====
setInterval(async () => {
    if (state.rotation > 0 && state.finishTime) {
        if (Date.now() >= state.finishTime && !state.notified) {
            state.notified = true;
            saveData();
            try {
                const channel = await client.channels.fetch(state.panelChannelId);
                if (channel) {
                    const currentKey = state.sequence[state.cycleIndex];
                    const nextKey = state.sequence[(state.cycleIndex + 1) % 4];

                    if (state.rotation === 1) {
                        await channel.send(`🔔 ${getMention(currentKey)}, seus packs da 1ª rotação estão prontos! Colha e replante a 2ª.`);
                        await sendDM(currentKey, `🌿 Opa! Seus packs da **1ª rotação** tão prontos!\nVai lá colher e replantar a 2ª leva. Lembra que são **79 packs** nos 4 terrenos (1 treehouse + 3 24x24). Confere as loc no #land-share!`);
                    } else if (state.rotation === 2) {
                        await channel.send(`🔔 ${getMention(currentKey)}, seus últimos packs estão prontos! Atenção ${getMention(nextKey)}: o ${getDisplayName(currentKey)} vai colher e já planta a sua vez!`);
                        await sendDM(currentKey, `🌿 Sua **2ª e última rotação** tá pronta!\nVai lá colher os 79 packs e **já replanta os packs do ${getDisplayName(nextKey)}** no terreno antes de sair — a pessoa já recebe os packs feitos!\n\nLembra das loc no #land-share (1 treehouse + 3 24x24).`);
                        await sendDM(nextKey, getMsgAvisoProximo(getDisplayName(currentKey)));
                    }
                }
            } catch (err) {}
        }
        updatePanel(false);
    }
}, CHECK_INTERVAL);

// ===== BOT READY =====
client.once('ready', () => {
    console.log(`Bot logado como ${client.user.tag}`);
    loadData();
    updatePanel(true);
});

// ===== MENSAGENS =====
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content === '!painel') {
        await sendNewPanel(message.channel);
        if (message.deletable) message.delete();
        return;
    }
    if (state.panelChannelId === message.channel.id) {
        setTimeout(() => updatePanel(false), 1000);
    }
});

// ===== INTERAÇÕES =====
client.on('interactionCreate', async (interaction) => {

    // ---- BOTÕES ----
    if (interaction.isButton()) {

        // PLANTAR
        if (interaction.customId === 'btn_plantar') {
            const currentKey = state.sequence[state.cycleIndex];
            const nextKey = state.sequence[(state.cycleIndex + 1) % 4];
            const roleMention = getRoleMention();

            if (state.rotation === 0) {
                state.rotation = 1;
                state.finishTime = Date.now() + THREE_DAYS_MS;
                state.notified = false;
                saveData();
                await interaction.reply({ content: `Packs plantados! Tempo iniciado: 3 dias.`, ephemeral: true });

            } else if (state.rotation === 1) {
                if (Date.now() < state.finishTime) return interaction.reply({ content: '🚫 Os packs ainda não estão prontos!', ephemeral: true });
                state.rotation = 2;
                state.finishTime = Date.now() + THREE_DAYS_MS;
                state.notified = false;
                saveData();
                await interaction.reply({ content: `2ª Rotação iniciada! Avisando o próximo da fila.`, ephemeral: true });
                await interaction.channel.send(`🚨 Atenção ${getMention(nextKey)}: O ${getDisplayName(currentKey)} plantou a 2ª (última) rotação. Em ~3 dias ele colhe e já planta a sua vez!`);
                await sendDM(nextKey, getMsgAvisoProximo(getDisplayName(currentKey)));

            } else if (state.rotation === 2) {
                if (Date.now() < state.finishTime) return interaction.reply({ content: '🚫 Aguardando colheita.', ephemeral: true });
                state.cycleIndex = (state.cycleIndex + 1) % 4;
                state.rotation = 1;
                state.finishTime = Date.now() + THREE_DAYS_MS;
                state.notified = false;
                saveData();
                await interaction.reply({ content: `✅ Turno finalizado! A contagem de 3 dias do ${getDisplayName(nextKey)} já começou!`, ephemeral: true });
                await interaction.channel.send(`✅ O ${getDisplayName(currentKey)} colheu e **já plantou** para o ${getMention(nextKey)}! Em 3 dias é a 1ª colheita do ${getDisplayName(nextKey)}.`);
                await sendDM(nextKey, `🌿 Fala! O **${getDisplayName(currentKey)}** acabou de colher e **já deixou seus packs no terreno**. Em ~3 dias você faz a 1ª colheita!\n\nConfere as loc no #land-share e boa sorte 🤙`);
            }
            updatePanel(true);
        }

        // TROCAR PLANTADOR ATUAL
        if (interaction.customId === 'btn_mudar_vez') {
            const options = getMemberOptions();
            if (options.length === 0) return interaction.reply({ content: '⚠️ Nenhum membro cadastrado.', ephemeral: true });
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_membro_direto')
                .setPlaceholder('Escolha quem é o plantador ATUAL agora')
                .addOptions(options);
            await interaction.reply({ content: 'Selecione o plantador atual:', components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        // PAINEL ADMIN
        if (interaction.customId === 'btn_admin') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '🚫 Acesso negado.', ephemeral: true });
            }
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('admin_ajustar_tempo').setLabel('⏳ Ajustar Horas').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('admin_reset').setLabel('🛑 Zerar Terreno').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('admin_fastforward').setLabel('⏩ Teste (10s)').setStyle(ButtonStyle.Secondary)
            );
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_config_ciclo').setLabel('⚙️ Editar Ordem do Ciclo').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('btn_gerenciar_membros').setLabel('👥 Gerenciar Membros').setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({ content: '**🛠️ Painel de Administração**', components: [row1, row2], ephemeral: true });
        }

        // ZERAR TERRENO — NÃO APAGA as tags/members
        if (interaction.customId === 'admin_reset') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            state.rotation = 0;
            state.finishTime = null;
            state.notified = false;
            // NÃO mexemos em state.members, state.rolePacksId, state.sequence, state.cycleIndex
            saveData();
            updatePanel(true);
            await interaction.reply({ content: '🛑 Terreno zerado. As tags e configurações foram mantidas!', ephemeral: true });
        }

        // FAST FORWARD
        if (interaction.customId === 'admin_fastforward') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            if (state.rotation > 0 && state.finishTime) {
                state.finishTime = Date.now() + 10000;
                state.notified = false;
                saveData();
                updatePanel(true);
                await interaction.reply({ content: '⏳ TESTE: 10 segundos para o alerta!', ephemeral: true });
            } else {
                await interaction.reply({ content: 'Não há packs plantados.', ephemeral: true });
            }
        }

        // AJUSTAR HORAS
        if (interaction.customId === 'admin_ajustar_tempo') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const modal = new ModalBuilder().setCustomId('modal_tempo').setTitle('Ajustar Tempo Restante');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('input_horas').setLabel('Quantas horas faltam? (Ex: 52 ou 2.5)').setStyle(TextInputStyle.Short).setRequired(true)
            ));
            await interaction.showModal(modal);
        }

        // EDITAR ORDEM DO CICLO
        if (interaction.customId === 'btn_config_ciclo') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const comps = getConfigComponents();
            if (comps.length === 0) return interaction.reply({ content: '⚠️ Cadastre membros primeiro!', ephemeral: true });
            await interaction.reply({ content: '**⚙️ Editar Ordem do Ciclo** (o ciclo repete infinitamente)', components: comps, ephemeral: true });
        }

        // GERENCIAR MEMBROS
        if (interaction.customId === 'btn_gerenciar_membros') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

            // Lista os membros atuais
            const lista = Object.entries(state.members).map(([k, m]) => `• **${m.name}** (chave: \`${k}\`, ID: \`${m.id}\`)`).join('\n');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('admin_add_membro').setLabel('➕ Adicionar / Editar Membro').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('admin_remover_membro').setLabel('🗑️ Remover Membro').setStyle(ButtonStyle.Danger)
            );
            await interaction.reply({
                content: `**👥 Membros Cadastrados:**\n${lista || 'Nenhum membro.'}\n\n*(Cargo @Packs ID: \`${state.rolePacksId || 'não definido'}\`)*`,
                components: [row],
                ephemeral: true
            });
        }

        // ADICIONAR / EDITAR MEMBRO
        if (interaction.customId === 'admin_add_membro') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const modal = new ModalBuilder().setCustomId('modal_add_membro').setTitle('Adicionar / Editar Membro');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('input_key').setLabel('Chave interna (sem espaço, ex: elu, tock2)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ex: elu')
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('input_nome').setLabel('Nome de exibição (ex: EluDelu)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ex: EluDelu')
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('input_id').setLabel('ID numérico do Discord').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ex: 210789096837218306')
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('input_cargo_packs').setLabel('Cargo @Packs ID (deixe em branco p/ manter)').setStyle(TextInputStyle.Short).setRequired(false).setValue(state.rolePacksId || '')
                )
            );
            await interaction.showModal(modal);
        }

        // REMOVER MEMBRO
        if (interaction.customId === 'admin_remover_membro') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const options = getMemberOptions();
            if (options.length === 0) return interaction.reply({ content: '⚠️ Nenhum membro para remover.', ephemeral: true });
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_remover_membro')
                .setPlaceholder('Selecione o membro para remover')
                .addOptions(options);
            await interaction.reply({ content: '⚠️ Qual membro deseja remover?', components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }
    }

    // ---- SELECT MENUS ----
    if (interaction.isStringSelectMenu()) {

        // Trocar plantador atual
        if (interaction.customId === 'select_membro_direto') {
            const selected = interaction.values[0];
            const idx = state.sequence.indexOf(selected);
            if (idx !== -1) {
                state.cycleIndex = idx;
            } else {
                // Se não estiver na sequência, bota na posição atual mesmo
                state.sequence[state.cycleIndex] = selected;
            }
            saveData();
            await interaction.update({ content: `✅ Plantador atual alterado para: **${getDisplayName(selected)}**.`, components: [] });
            updatePanel(true);
        }

        // Editar ordem do ciclo
        if (interaction.customId.startsWith('set_cycle_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const step = parseInt(interaction.customId.split('_')[2]);
            state.sequence[step] = interaction.values[0];
            saveData();
            await interaction.update({ components: getConfigComponents() });
            updatePanel(true);
        }

        // Remover membro
        if (interaction.customId === 'select_remover_membro') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const key = interaction.values[0];
            const nome = getDisplayName(key);
            delete state.members[key];
            // Remove da sequence também se estiver lá
            state.sequence = state.sequence.map(k => k === key ? (Object.keys(state.members)[0] || 'elu') : k);
            saveData();
            await interaction.update({ content: `🗑️ Membro **${nome}** removido com sucesso!`, components: [] });
            updatePanel(true);
        }
    }

    // ---- MODAIS ----
    if (interaction.isModalSubmit()) {

        if (interaction.customId === 'modal_tempo') {
            const horas = parseFloat(interaction.fields.getTextInputValue('input_horas').replace(',', '.'));
            if (isNaN(horas)) return interaction.reply({ content: '⚠️ Valor inválido.', ephemeral: true });
            if (state.rotation === 0 || !state.finishTime) return interaction.reply({ content: 'Sem plantação ativa.', ephemeral: true });
            state.finishTime = Date.now() + (horas * 60 * 60 * 1000);
            state.notified = false;
            saveData();
            updatePanel(true);
            await interaction.reply({ content: `✅ Timer ajustado para **${horas} horas**.`, ephemeral: true });
        }

        if (interaction.customId === 'modal_add_membro') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const rawKey  = interaction.fields.getTextInputValue('input_key').trim().toLowerCase().replace(/\s+/g, '_');
            const nome    = interaction.fields.getTextInputValue('input_nome').trim();
            const rawId   = interaction.fields.getTextInputValue('input_id').trim();
            const rawCargo= interaction.fields.getTextInputValue('input_cargo_packs').trim();

            const idMatch = rawId.match(/\d{17,19}/);
            if (!idMatch) return interaction.reply({ content: '⚠️ ID inválido. Cole apenas os números.', ephemeral: true });

            state.members[rawKey] = { name: nome, id: idMatch[0] };
            if (rawCargo !== '') {
                const cargoMatch = rawCargo.match(/\d{17,19}/);
                if (cargoMatch) state.rolePacksId = cargoMatch[0];
            }
            saveData();
            await interaction.reply({ content: `✅ Membro **${nome}** salvo! (chave: \`${rawKey}\`, ID: \`${idMatch[0]}\`)`, ephemeral: true });
            updatePanel(true);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
