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

const NAMES = { elu: 'Elu', trollei: 'Trollei', tock: 'Tock' };

let state = {
    sequence: ['elu', 'trollei', 'elu', 'tock'],
    cycleIndex: 0,
    rotation: 0, // 0 = Livre, 1 = 1/2, 2 = 2/2
    finishTime: null,
    notified: false,
    panelMessageId: null,
    panelChannelId: null,
    rolePacksId: null,
    users: { elu: '', trollei: '', tock: '' }
};

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            state = { ...state, ...JSON.parse(data) };
            if (!state.sequence || state.sequence.length !== 4) {
                state.sequence = ['elu', 'trollei', 'elu', 'tock'];
            }
        } catch (err) {
            console.error('Erro ao ler data.json:', err);
        }
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

function getMention(key) {
    if (state.users[key] && state.users[key].trim() !== '') {
        return state.users[key];
    }
    return `**${NAMES[key] || key}**`;
}

function getRoleMention() {
    if (state.rolePacksId && state.rolePacksId.trim() !== '') {
        return `<@&${state.rolePacksId.replace(/[<@&>]/g, '')}>`;
    }
    return '';
}

async function sendDM(mentionString, messageText) {
    if (!mentionString) return;
    const match = mentionString.match(/\d{17,19}/);
    if (!match) return;
    try {
        const userId = match[0];
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) {
            await user.send(messageText).catch(() => null);
        }
    } catch (err) {}
}

function getConfigComponents() {
    const components = [];
    for (let i = 0; i < 4; i++) {
        const currentVal = state.sequence[i] || 'elu';
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`set_cycle_${i}`)
            .setPlaceholder(`Passo ${i + 1}`)
            .addOptions([
                { label: `Passo ${i + 1}: Elu`, value: 'elu', default: currentVal === 'elu' },
                { label: `Passo ${i + 1}: Trollei`, value: 'trollei', default: currentVal === 'trollei' },
                { label: `Passo ${i + 1}: Tock`, value: 'tock', default: currentVal === 'tock' }
            ]);
        components.push(new ActionRowBuilder().addComponents(menu));
    }
    return components;
}

async function sendNewPanel(channel) {
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
                statusText = `✅ **PRONTOS PARA COLHER (1/2)!**\nColha os packs e clique em Re-plantei.`;
            } else {
                statusText = `✅ **PRONTOS PARA COLHER (2/2)!**\nColha os últimos packs e libere o terreno.`;
            }
            embed.setColor('#e74c3c');
        } else {
            const timeLeft = formatTimeLeft(state.finishTime - Date.now());
            statusText = `⏳ **Tempo restante exato:** ${timeLeft}\nFicam prontos em: <t:${timestamp}:R>\n(Data exata: <t:${timestamp}:f>)`;
        }
        
        let proxAviso = `\n\n👉 **Próximo da vez:** ${getMention(nextKey)}`;
        embed.setDescription(`**Plantador Atual:** ${getMention(currentKey)}\n**Rotação:** ${state.rotation} de 2\n\n${statusText}${proxAviso}`);
    }

    const rowButtons = new ActionRowBuilder();
    const btnPlant = new ButtonBuilder().setCustomId('btn_plantar');

    if (state.rotation === 0) {
        btnPlant.setLabel(`Plantei Packs (Sou o ${NAMES[currentKey]})`).setStyle(ButtonStyle.Success);
    } else if (state.rotation === 1) {
        if (Date.now() < state.finishTime) {
            btnPlant.setLabel('Aguardando 1ª Colheita...').setStyle(ButtonStyle.Secondary).setDisabled(true);
        } else {
            btnPlant.setLabel('Colhi e Re-plantei (Ir p/ 2/2)').setStyle(ButtonStyle.Success).setDisabled(false);
        }
    } else if (state.rotation === 2) {
        if (Date.now() < state.finishTime) {
            btnPlant.setLabel('Aguardando 2ª Colheita...').setStyle(ButtonStyle.Secondary).setDisabled(true);
        } else {
            btnPlant.setLabel('Colhi Tudo (Liberar Terreno)').setStyle(ButtonStyle.Primary).setDisabled(false);
        }
    }

    rowButtons.addComponents(btnPlant);

    const btnChange = new ButtonBuilder()
        .setCustomId('btn_mudar_vez')
        .setLabel('Trocar Plantador Atual')
        .setStyle(ButtonStyle.Secondary);
    rowButtons.addComponents(btnChange);
    
    const btnAdmin = new ButtonBuilder()
        .setCustomId('btn_admin')
        .setLabel('🛠️ Admin')
        .setStyle(ButtonStyle.Danger);
    rowButtons.addComponents(btnAdmin);

    const sentMessage = await channel.send({ embeds: [embed], components: [rowButtons] });
    
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
            if (lastMsg && lastMsg.id !== state.panelMessageId) {
                shouldResend = true;
            }
        }

        if (shouldResend) {
            await sendNewPanel(channel);
            return;
        }

        const message = await channel.messages.fetch(state.panelMessageId).catch(() => null);
        if (!message) {
            await sendNewPanel(channel);
            return;
        }

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
                    statusText = `✅ **PRONTOS PARA COLHER (1/2)!**\nColha os packs e clique em Re-plantei.`;
                } else {
                    statusText = `✅ **PRONTOS PARA COLHER (2/2)!**\nColha os últimos packs e libere o terreno.`;
                }
                embed.setColor('#e74c3c');
            } else {
                const timeLeft = formatTimeLeft(state.finishTime - Date.now());
                statusText = `⏳ **Tempo restante exato:** ${timeLeft}\nFicam prontos em: <t:${timestamp}:R>\n(Data exata: <t:${timestamp}:f>)`;
            }
            
            let proxAviso = `\n\n👉 **Próximo da vez:** ${getMention(nextKey)}`;
            embed.setDescription(`**Plantador Atual:** ${getMention(currentKey)}\n**Rotação:** ${state.rotation} de 2\n\n${statusText}${proxAviso}`);
        }

        const rowButtons = new ActionRowBuilder();
        const btnPlant = new ButtonBuilder().setCustomId('btn_plantar');

        if (state.rotation === 0) {
            btnPlant.setLabel(`Plantei Packs (Sou o ${NAMES[currentKey]})`).setStyle(ButtonStyle.Success);
        } else if (state.rotation === 1) {
            if (Date.now() < state.finishTime) {
                btnPlant.setLabel('Aguardando 1ª Colheita...').setStyle(ButtonStyle.Secondary).setDisabled(true);
            } else {
                btnPlant.setLabel('Colhi e Re-plantei (Ir p/ 2/2)').setStyle(ButtonStyle.Success).setDisabled(false);
            }
        } else if (state.rotation === 2) {
            if (Date.now() < state.finishTime) {
                btnPlant.setLabel('Aguardando 2ª Colheita...').setStyle(ButtonStyle.Secondary).setDisabled(true);
            } else {
                btnPlant.setLabel('Colhi Tudo (Liberar Terreno)').setStyle(ButtonStyle.Primary).setDisabled(false);
            }
        }

        rowButtons.addComponents(btnPlant);

        const btnChange = new ButtonBuilder()
            .setCustomId('btn_mudar_vez')
            .setLabel('Trocar Plantador Atual')
            .setStyle(ButtonStyle.Secondary);
        rowButtons.addComponents(btnChange);
        
        const btnAdmin = new ButtonBuilder()
            .setCustomId('btn_admin')
            .setLabel('🛠️ Admin')
            .setStyle(ButtonStyle.Danger);
        rowButtons.addComponents(btnAdmin);

        await message.edit({ embeds: [embed], components: [rowButtons] });
    } catch (error) {
        console.error('Erro ao atualizar o painel:', error);
    }
}

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
                        await channel.send(`🔔 ${getMention(currentKey)}, seus packs da 1ª rotação estão prontos! Colha e replante.`);
                        await sendDM(state.users[currentKey], `🌿 **Alerta do ArcheAge:**\nSeus packs da 1ª rotação estão PRONTOS! Vá lá colher e replantar a última leva.`);
                    } else if (state.rotation === 2) {
                        const roleMention = getRoleMention();
                        await channel.send(`🔔 ${getMention(currentKey)}, seus últimos packs estão prontos!\n\n${roleMention} Atenção ${getMention(nextKey)}: O terreno ficará livre em instantes!`);
                        
                        await sendDM(state.users[currentKey], `🌿 **Alerta do ArcheAge:**\nSeus ÚLTIMOS packs estão PRONTOS! Vá lá colher e liberar o terreno.`);
                        await sendDM(state.users[nextKey], `🚨 **Prepare-se!**\nO terreno ficará livre em instantes! Já pode ir finalizando seus packs para plantar.`);
                    }
                }
            } catch (err) {}
        }
        updatePanel(false);
    }
}, CHECK_INTERVAL);

client.once('ready', () => {
    console.log(`Bot logado como ${client.user.tag}`);
    loadData();
    updatePanel(true);
});

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

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
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
                if (Date.now() < state.finishTime) {
                    return interaction.reply({ content: '🚫 Os packs ainda não estão prontos!', ephemeral: true });
                }
                state.rotation = 2;
                state.finishTime = Date.now() + THREE_DAYS_MS;
                state.notified = false;
                saveData();

                await interaction.reply({ content: `2ª Rotação iniciada! Avisando o próximo da fila.`, ephemeral: true });
                
                const channel = interaction.channel;
                if (channel) {
                    await channel.send(`${roleMention} 🚨 Alerta de Preparação: O ${NAMES[currentKey]} plantou a ÚLTIMA rotação dele. Em exatos 3 dias será a vez de ${getMention(nextKey)}! Já vão craftando os packs!`);
                }
                
                await sendDM(state.users[nextKey], `🚨 **Alerta de Preparação (ArcheAge)!**\nO ${NAMES[currentKey]} acabou de plantar a ÚLTIMA rotação dele. Em exatos 3 dias será a SUA VEZ de plantar!`);
                
            } else if (state.rotation === 2) {
                if (Date.now() < state.finishTime) {
                    return interaction.reply({ content: '🚫 Aguardando colheita.', ephemeral: true });
                }

                state.cycleIndex = (state.cycleIndex + 1) % 4;
                state.rotation = 0;
                state.finishTime = null;
                state.notified = false;
                saveData();

                await interaction.reply({ content: `Terreno liberado! O próximo foi notificado.`, ephemeral: true });
                
                const channel = interaction.channel;
                if (channel) {
                    await channel.send(`✅ O terreno foi liberado por ${NAMES[currentKey]}! Agora é a vez de ${getMention(nextKey)} plantar.\n*(Se precisar trocar a pessoa, use o botão "Trocar Plantador Atual")*`);
                }
                await sendDM(state.users[nextKey], `🚨 **O Terreno está LIVRE!**\nO ${NAMES[currentKey]} terminou a colheita. É a sua vez de plantar!`);
            }
            updatePanel(true);
        }

        if (interaction.customId === 'btn_mudar_vez') {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_membro_direto')
                .setPlaceholder('Escolha quem vai assumir o terreno agora')
                .addOptions([
                    { label: 'Elu', value: 'elu' },
                    { label: 'Trollei', value: 'trollei' },
                    { label: 'Tock', value: 'tock' }
                ]);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({ 
                content: 'Selecione quem é o plantador ATUAL (isso não afeta as regras do ciclo):', 
                components: [row],
                ephemeral: true 
            });
        }
        
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
                new ButtonBuilder().setCustomId('btn_edit_tags').setLabel('🏷️ Editar IDs das Tags').setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({
                content: '**🛠️ Painel de Administração**\n*(Todos os comandos antigos foram transformados nesses botões para facilitar)*',
                components: [row1, row2],
                ephemeral: true
            });
        }

        if (interaction.customId === 'admin_fastforward') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            if (state.rotation > 0 && state.finishTime) {
                state.finishTime = Date.now() + 10000;
                state.notified = false;
                saveData();
                updatePanel(true);
                await interaction.reply({ content: "⏳ TESTE: O tempo foi acelerado para 10 segundos.", ephemeral: true });
            } else {
                await interaction.reply({ content: "Não há packs plantados no momento.", ephemeral: true });
            }
        }

        if (interaction.customId === 'admin_reset') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            state.rotation = 0; state.finishTime = null; state.notified = false; saveData();
            updatePanel(true);
            await interaction.reply({ content: "🛑 Estado resetado para LIVRE.", ephemeral: true });
        }

        if (interaction.customId === 'admin_ajustar_tempo') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const modal = new ModalBuilder().setCustomId('modal_tempo').setTitle('Ajustar Tempo Restante');
            const input = new TextInputBuilder()
                .setCustomId('input_horas')
                .setLabel('Quantas horas faltam? (Ex: 52 ou 2.5)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_config_ciclo') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            await interaction.reply({
                content: '**⚙️ Editar Ordem do Ciclo**\nDefina quem planta em cada um dos 4 passos (o ciclo se repete infinitamente):',
                components: getConfigComponents(),
                ephemeral: true
            });
        }

        if (interaction.customId === 'btn_edit_tags') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const modal = new ModalBuilder()
                .setCustomId('modal_tags')
                .setTitle('Configurar Menções (IDs numéricos)');

            const packsInput = new TextInputBuilder().setCustomId('input_packs').setLabel('Cargo @Packs (Copie e cole APENAS O NÚMERO)').setStyle(TextInputStyle.Short).setRequired(false).setValue(state.rolePacksId || '');
            const eluInput = new TextInputBuilder().setCustomId('input_elu').setLabel('ID do Elu (Copie e cole APENAS O NÚMERO)').setStyle(TextInputStyle.Short).setRequired(false).setValue(state.users.elu || '');
            const trolleiInput = new TextInputBuilder().setCustomId('input_trollei').setLabel('ID do Trollei (APENAS NÚMERO)').setStyle(TextInputStyle.Short).setRequired(false).setValue(state.users.trollei || '');
            const tockInput = new TextInputBuilder().setCustomId('input_tock').setLabel('ID do Tock (APENAS NÚMERO)').setStyle(TextInputStyle.Short).setRequired(false).setValue(state.users.tock || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(packsInput),
                new ActionRowBuilder().addComponents(eluInput),
                new ActionRowBuilder().addComponents(trolleiInput),
                new ActionRowBuilder().addComponents(tockInput)
            );

            await interaction.showModal(modal);
        }
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_membro_direto') {
            const selected = interaction.values[0];
            let idx = state.sequence.indexOf(selected);
            if (idx !== -1) {
                state.cycleIndex = idx;
            } else {
                state.sequence[state.cycleIndex] = selected; 
            }
            saveData();
            await interaction.update({ content: `✅ A vez foi alterada para: **${NAMES[selected]}**.`, components: [] });
            updatePanel(true);
        }

        if (interaction.customId.startsWith('set_cycle_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            
            const step = parseInt(interaction.customId.split('_')[2]);
            const selected = interaction.values[0];
            
            state.sequence[step] = selected;
            saveData();
            
            await interaction.update({ components: getConfigComponents() });
            updatePanel(true);
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_tempo') {
            const val = interaction.fields.getTextInputValue('input_horas');
            const horas = parseFloat(val.replace(',', '.'));
            if (isNaN(horas)) {
                return interaction.reply({ content: '⚠️ Valor inválido. Digite apenas números.', ephemeral: true });
            }
            if (state.rotation === 0 || !state.finishTime) {
                return interaction.reply({ content: 'O terreno está livre, não há tempo para ajustar.', ephemeral: true });
            }
            state.finishTime = Date.now() + (horas * 60 * 60 * 1000);
            state.notified = false;
            saveData();
            updatePanel(true);
            await interaction.reply({ content: `✅ O timer foi ajustado para **${horas} horas**.`, ephemeral: true });
        }

        if (interaction.customId === 'modal_tags') {
            const rawPacks = interaction.fields.getTextInputValue('input_packs');
            const rawElu = interaction.fields.getTextInputValue('input_elu');
            const rawTrollei = interaction.fields.getTextInputValue('input_trollei');
            const rawTock = interaction.fields.getTextInputValue('input_tock');

            const extractRole = (str) => {
                if (!str || str.trim() === '') return '';
                const match = str.match(/\d{17,19}/);
                return match ? match[0] : str;
            };

            const extractMention = (str) => {
                if (!str || str.trim() === '') return '';
                const match = str.match(/\d{17,19}/);
                if (match) return `<@${match[0]}>`; 
                return str; 
            };

            state.rolePacksId = extractRole(rawPacks);
            state.users.elu = extractMention(rawElu);
            state.users.trollei = extractMention(rawTrollei);
            state.users.tock = extractMention(rawTock);

            saveData();
            await interaction.reply({ content: '✅ Tags numéricas salvas com sucesso!', ephemeral: true });
            updatePanel(true);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
