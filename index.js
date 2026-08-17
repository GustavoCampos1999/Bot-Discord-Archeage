const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, PermissionsBitField } = require('discord.js');
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
    sequence: ['elu', 'trollei', 'elu', 'tock'], // O ciclo customizável
    cycleIndex: 0,
    rotation: 0, 
    finishTime: null,
    notified: false,
    panelMessageId: null,
    panelChannelId: null,
    rolePacksId: null,
    users: { elu: null, trollei: null, tock: null }
};

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            state = { ...state, ...JSON.parse(data) };
            if (!state.sequence || state.sequence.length === 0) {
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
    return state.users[key] ? state.users[key] : `**${NAMES[key] || key}**`;
}

async function sendNewPanel(channel) {
    const embed = new EmbedBuilder().setTitle('🌿 Rotação Automática de Packs').setColor('#2ecc71');
    const currentKey = state.sequence[state.cycleIndex];
    const nextKey = state.sequence[(state.cycleIndex + 1) % state.sequence.length];

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

    // Botão de Forçar Vez sempre disponível (mas bloqueado para Admins no código de interação)
    const btnChange = new ButtonBuilder()
        .setCustomId('btn_mudar_vez')
        .setLabel('Admin: Forçar Plantador Atual')
        .setStyle(ButtonStyle.Secondary);
    rowButtons.addComponents(btnChange);

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
        const nextKey = state.sequence[(state.cycleIndex + 1) % state.sequence.length];

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
            .setLabel('Admin: Forçar Plantador Atual')
            .setStyle(ButtonStyle.Secondary);
        rowButtons.addComponents(btnChange);

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
                    const nextKey = state.sequence[(state.cycleIndex + 1) % state.sequence.length];
                    
                    if (state.rotation === 1) {
                        await channel.send(`🔔 ${getMention(currentKey)}, seus packs da 1ª rotação estão prontos! Colha e replante.`);
                    } else if (state.rotation === 2) {
                        const roleMention = state.rolePacksId ? `<@&${state.rolePacksId}>` : '';
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

    // Configurações de tags
    if (message.content.startsWith('!setrole')) {
        const role = message.mentions.roles.first();
        if (role) {
            state.rolePacksId = role.id;
            saveData();
            message.reply(`Cargo @Packs configurado com sucesso: ${role.name}`);
        }
    } else if (message.content.startsWith('!setelu')) {
        const match = message.content.match(/<@&?\d+>/);
        if (match) { state.users.elu = match[0]; saveData(); message.reply(`Elu setado para: ${match[0]}`); }
    } else if (message.content.startsWith('!settrollei')) {
        const match = message.content.match(/<@&?\d+>/);
        if (match) { state.users.trollei = match[0]; saveData(); message.reply(`Trollei setado para: ${match[0]}`); }
    } else if (message.content.startsWith('!settock')) {
        const match = message.content.match(/<@&?\d+>/);
        if (match) { state.users.tock = match[0]; saveData(); message.reply(`Tock setado para: ${match[0]}`); }
    } 
    
    // Comandos de Administrador
    else if (message.content.startsWith('!admin_reset')) {
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
    } else if (message.content.startsWith('!setordem')) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("🚫 Apenas Admins.");
        const args = message.content.toLowerCase().split(' ').slice(1);
        const validKeys = ['elu', 'trollei', 'tock'];
        const newSequence = [];
        
        for (const arg of args) {
            if (validKeys.includes(arg)) newSequence.push(arg);
        }
        
        if (newSequence.length === 0) {
            return message.reply("Uso correto: `!setordem elu trollei tock elu` (escreva os nomes na ordem desejada).");
        }
        
        state.sequence = newSequence;
        state.cycleIndex = 0; // reseta para o primeiro da nova ordem
        saveData();
        updatePanel(true);
        message.reply(`✅ Nova ordem configurada com sucesso: **${newSequence.map(k => NAMES[k]).join(' ➔ ')}**`);
    }

    if (state.panelChannelId === message.channel.id) {
        setTimeout(() => updatePanel(false), 1000);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.customId === 'btn_plantar') {
            const currentKey = state.sequence[state.cycleIndex];
            const nextKey = state.sequence[(state.cycleIndex + 1) % state.sequence.length];
            const roleMention = state.rolePacksId ? `<@&${state.rolePacksId}>` : '';

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

                state.cycleIndex = (state.cycleIndex + 1) % state.sequence.length;
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
                return interaction.reply({ content: '🚫 Apenas administradores do servidor podem forçar a vez ou alterar a ordem.', ephemeral: true });
            }

            const options = state.sequence.map((key, index) => {
                const nKey = state.sequence[(index + 1) % state.sequence.length];
                return {
                    label: `Passo ${index+1}: Vez do ${NAMES[key]} (Depois: ${NAMES[nKey]})`,
                    value: index.toString()
                };
            });

            // O Discord tem limite de 25 opções no select menu, mas nossa lista dificilmente passará disso.
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_cycle')
                .setPlaceholder('Escolha quem está assumindo AGORA')
                .addOptions(options.slice(0, 25));

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({ 
                content: 'Altere manualmente quem deve ser o plantador de agora (pula os anteriores):', 
                components: [row],
                ephemeral: true 
            });
        }
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_cycle') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '🚫 Acesso negado.', ephemeral: true });
            }
            const index = parseInt(interaction.values[0]);
            state.cycleIndex = index;
            
            // Se o admin trocou a vez e estava no meio de um timer, talvez seja bom avisar ou zerar
            // Mas vamos manter a lógica simples: ele só muda o nome do plantador atual
            saveData();
            
            const novo = state.sequence[index];
            await interaction.update({ content: `✅ O plantador atual foi forçado para: **${NAMES[novo]}**.`, components: [] });
            updatePanel(true);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
