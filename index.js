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
    rotation: 0, 
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
    
    const btnTags = new ButtonBuilder()
        .setCustomId('btn_edit_tags')
        .setLabel('✏️ Editar Tags (@)')
        .setStyle(ButtonStyle.Primary);
        
    components.push(new ActionRowBuilder().addComponents(btnTags));
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
                statusText = `✅ **PRONTOS PARA COLHER!**\nColha os packs e clique em Re-plantei para a sua última leva.`;
            } else {
                statusText = `✅ **PRONTOS PARA COLHER (Última Rotação)!**\nColha os packs. O terreno ficará livre para ${getMention(nextKey)} plantar.`;
            }
            embed.setColor('#e74c3c');
        } else {
            const timeLeft = formatTimeLeft(state.finishTime - Date.now());
            statusText = `⏳ **Tempo restante exato:** ${timeLeft}\nFicam prontos em: <t:${timestamp}:R>\n(Data exata: <t:${timestamp}:f>)`;
        }
        
        let proxAviso = '';
        if (state.rotation === 2) {
            proxAviso = `\n\n👉 **Próximo da vez:** ${getMention(nextKey)} (Já foi avisado!)`;
        }

        embed.setDescription(`**Plantador Atual:** ${getMention(currentKey)}\n**Rotação:** ${state.rotation} de 2\n\n${statusText}${proxAviso}`);
    }

    const rowButtons = new ActionRowBuilder();
    const btnPlant = new ButtonBuilder()
        .setCustomId('btn_plantar')
        .setStyle(ButtonStyle.Success);

    if (state.rotation === 0) {
        btnPlant.setLabel(`Plantei Packs (Sou o ${NAMES[currentKey]})`);
    } else if (state.rotation === 1) {
        if (Date.now() < state.finishTime) {
            btnPlant.setLabel('Aguarde o tempo para Re-plantar').setDisabled(true);
        } else {
            btnPlant.setLabel('Re-plantei (Última Rotação)').setDisabled(false);
        }
    } else if (state.rotation === 2) {
        if (Date.now() < state.finishTime) {
            btnPlant.setLabel('Aguardando Colheita...').setDisabled(true);
        } else {
            btnPlant.setLabel(`Plantei Packs (Iniciar vez de ${NAMES[nextKey]})`).setDisabled(false);
        }
    }

    rowButtons.addComponents(btnPlant);

    const btnChange = new ButtonBuilder()
        .setCustomId('btn_mudar_vez')
        .setLabel('🛠️ Alterar Passo Atual')
        .setStyle(ButtonStyle.Secondary);
    rowButtons.addComponents(btnChange);
    
    const btnConfig = new ButtonBuilder()
        .setCustomId('btn_config')
        .setLabel('⚙️ Configurações (Apenas p/ mudar a regra)')
        .setStyle(ButtonStyle.Secondary);
    rowButtons.addComponents(btnConfig);

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
                    statusText = `✅ **PRONTOS PARA COLHER!**\nColha os packs e clique em Re-plantei para a sua última leva.`;
                } else {
                    statusText = `✅ **PRONTOS PARA COLHER (Última Rotação)!**\nColha os packs. O terreno ficará livre para ${getMention(nextKey)} plantar.`;
                }
                embed.setColor('#e74c3c');
            } else {
                const timeLeft = formatTimeLeft(state.finishTime - Date.now());
                statusText = `⏳ **Tempo restante exato:** ${timeLeft}\nFicam prontos em: <t:${timestamp}:R>\n(Data exata: <t:${timestamp}:f>)`;
            }
            
            let proxAviso = '';
            if (state.rotation === 2) {
                proxAviso = `\n\n👉 **Próximo da vez:** ${getMention(nextKey)} (Já foi avisado!)`;
            }

            embed.setDescription(`**Plantador Atual:** ${getMention(currentKey)}\n**Rotação:** ${state.rotation} de 2\n\n${statusText}${proxAviso}`);
        }

        const rowButtons = new ActionRowBuilder();
        const btnPlant = new ButtonBuilder()
            .setCustomId('btn_plantar')
            .setStyle(ButtonStyle.Success);

        if (state.rotation === 0) {
            btnPlant.setLabel(`Plantei Packs (Sou o ${NAMES[currentKey]})`);
        } else if (state.rotation === 1) {
            if (Date.now() < state.finishTime) {
                btnPlant.setLabel('Aguarde o tempo para Re-plantar').setDisabled(true);
            } else {
                btnPlant.setLabel('Re-plantei (Última Rotação)').setDisabled(false);
            }
        } else if (state.rotation === 2) {
            if (Date.now() < state.finishTime) {
                btnPlant.setLabel('Aguardando Colheita...').setDisabled(true);
            } else {
                btnPlant.setLabel(`Plantei Packs (Iniciar vez de ${NAMES[nextKey]})`).setDisabled(false);
            }
        }

        rowButtons.addComponents(btnPlant);

        const btnChange = new ButtonBuilder()
            .setCustomId('btn_mudar_vez')
            .setLabel('🛠️ Alterar Passo Atual')
            .setStyle(ButtonStyle.Secondary);
        rowButtons.addComponents(btnChange);
        
        const btnConfig = new ButtonBuilder()
            .setCustomId('btn_config')
            .setLabel('⚙️ Configurações (Apenas p/ mudar a regra)')
            .setStyle(ButtonStyle.Secondary);
        rowButtons.addComponents(btnConfig);

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
                    } else if (state.rotation === 2) {
                        const roleMention = getRoleMention();
                        await channel.send(`🔔 ${getMention(currentKey)}, seus últimos packs estão prontos!\n\n${roleMention} Atenção ${getMention(nextKey)}: O terreno ficará livre em instantes!`);
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

    if (message.content.startsWith('!admin_reset')) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("🚫 Apenas Admins.");
        state.rotation = 0; state.finishTime = null; state.notified = false; saveData();
        updatePanel(true);
        message.reply("Estado resetado para LIVRE.");
    } else if (message.content.startsWith('!test_fastforward')) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("🚫 Apenas Admins.");
        if (state.rotation > 0 && state.finishTime) {
            state.finishTime = Date.now() + 10000;
            state.notified = false;
            saveData();
            updatePanel(true);
            message.reply("⏳ TESTE: O tempo foi acelerado! Os packs ficarão prontos em 10 segundos.");
        } else {
            message.reply("Não há packs plantados no momento para acelerar o tempo.");
        }
    } else if (message.content.startsWith('!set_tempo')) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("🚫 Apenas Admins.");
        const args = message.content.split(' ');
        if (args.length < 2 || isNaN(args[1])) {
            return message.reply("⚠️ Uso correto: `!set_tempo 52` (para definir que faltam exatamente 52 horas).");
        }
        if (state.rotation === 0 || !state.finishTime) {
            return message.reply("O terreno está livre, não há plantação ativa para ajustar o tempo.");
        }
        
        const horas = parseFloat(args[1]);
        state.finishTime = Date.now() + (horas * 60 * 60 * 1000);
        state.notified = false;
        saveData();
        updatePanel(true);
        message.reply(`✅ O timer foi ajustado na mão! Agora faltam exatamente **${horas} horas** para a colheita ficar pronta.`);
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
                
            } else if (state.rotation === 2) {
                if (Date.now() < state.finishTime) {
                    return interaction.reply({ content: '🚫 Aguardando colheita.', ephemeral: true });
                }

                state.cycleIndex = (state.cycleIndex + 1) % 4;
                state.rotation = 1;
                state.finishTime = Date.now() + THREE_DAYS_MS;
                state.notified = false;
                saveData();

                await interaction.reply({ content: `Packs plantados pela nova pessoa! Ciclo avançado.`, ephemeral: true });
            }
            updatePanel(true);
        }

        if (interaction.customId === 'btn_mudar_vez') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '🚫 Acesso negado.', ephemeral: true });
            }

            const options = state.sequence.map((key, index) => {
                const nKey = state.sequence[(index + 1) % 4];
                return {
                    label: `Passo ${index+1}: Vez do ${NAMES[key]} (Depois: ${NAMES[nKey]})`,
                    value: index.toString()
                };
            });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_cycle_index')
                .setPlaceholder('Escolha quem está assumindo AGORA')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({ 
                content: 'Altere manualmente quem deve ser o plantador de agora (pula os anteriores):', 
                components: [row],
                ephemeral: true 
            });
        }
        
        if (interaction.customId === 'btn_config') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '🚫 Acesso negado.', ephemeral: true });
            }

            await interaction.reply({
                content: '**⚙️ Painel de Configurações**\nDefina quem planta em cada um dos 4 passos do ciclo (ele se repete infinitamente após o Passo 4):',
                components: getConfigComponents(),
                ephemeral: true
            });
        }
        
        if (interaction.customId === 'btn_edit_tags') {
            const modal = new ModalBuilder()
                .setCustomId('modal_tags')
                .setTitle('Configurar Menções (@)');

            const packsInput = new TextInputBuilder()
                .setCustomId('input_packs')
                .setLabel('Cargo @Packs (copie a Menção ou ID)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(state.rolePacksId || '');
                
            const eluInput = new TextInputBuilder()
                .setCustomId('input_elu')
                .setLabel('Tag do Elu (copie a Menção ou ID)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(state.users.elu || '');
                
            const trolleiInput = new TextInputBuilder()
                .setCustomId('input_trollei')
                .setLabel('Tag do Trollei (copie a Menção ou ID)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(state.users.trollei || '');
                
            const tockInput = new TextInputBuilder()
                .setCustomId('input_tock')
                .setLabel('Tag do Tock (copie a Menção ou ID)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(state.users.tock || '');

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
        if (interaction.customId.startsWith('set_cycle_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            
            // "set_cycle_0" -> 0
            const step = parseInt(interaction.customId.split('_')[2]);
            const selected = interaction.values[0];
            
            state.sequence[step] = selected;
            saveData();
            
            await interaction.update({ components: getConfigComponents() });
            updatePanel(true);
        }
        
        if (interaction.customId === 'select_cycle_index') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '🚫 Acesso negado.', ephemeral: true });
            }
            const index = parseInt(interaction.values[0]);
            state.cycleIndex = index;
            saveData();
            
            const novo = state.sequence[index];
            await interaction.update({ content: `✅ O plantador atual foi forçado para: **${NAMES[novo]}**.`, components: [] });
            updatePanel(true);
        }
    }

    if (interaction.isModalSubmit()) {
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
                const match = str.match(/<@&?\d+>/);
                if (match) return match[0];
                const idMatch = str.match(/\d{17,19}/);
                if (idMatch) return `<@${idMatch[0]}>`; 
                return str; 
            };

            state.rolePacksId = extractRole(rawPacks);
            state.users.elu = extractMention(rawElu);
            state.users.trollei = extractMention(rawTrollei);
            state.users.tock = extractMention(rawTock);

            saveData();
            await interaction.reply({ content: '✅ Tags salvas com sucesso!', ephemeral: true });
            updatePanel(true);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
