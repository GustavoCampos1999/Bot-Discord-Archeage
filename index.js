const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// Configuração do Express para o Render e UptimeRobot
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
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000; // 3 dias em milissegundos
const CHECK_INTERVAL = 60 * 1000; // 1 minuto

// Variável para armazenar o estado atual
let state = {
    activePlanterId: null,
    rotation: 0,
    finishTime: null,
    notified: false,
    panelMessageId: null,
    panelChannelId: null,
    rolePacksId: null // Opcional: ID do cargo @Packs para marcar
};

// Carrega os dados se o arquivo existir
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            state = { ...state, ...JSON.parse(data) };
        } catch (err) {
            console.error('Erro ao ler data.json:', err);
        }
    }
}

// Salva os dados no arquivo
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// Função para atualizar a mensagem do painel
async function updatePanel() {
    if (!state.panelChannelId || !state.panelMessageId) return;

    try {
        const channel = await client.channels.fetch(state.panelChannelId);
        if (!channel) return;
        const message = await channel.messages.fetch(state.panelMessageId);
        if (!message) return;

        const embed = new EmbedBuilder()
            .setTitle('🌿 Rotação de Packs Envelhecidos')
            .setColor('#2ecc71');

        if (!state.activePlanterId) {
            embed.setDescription('O terreno está **LIVRE**. Alguém pode plantar!');
            embed.setColor('#3498db');
        } else {
            const timestamp = Math.floor(state.finishTime / 1000);
            
            let statusText = '';
            if (Date.now() >= state.finishTime) {
                statusText = `✅ **PRONTOS PARA COLHER!**\nColha os packs e se for replantar, clique em Re-plantei.`;
                embed.setColor('#e74c3c');
            } else {
                statusText = `⏳ Ficam prontos em: <t:${timestamp}:R>\n(Data exata: <t:${timestamp}:f>)`;
            }

            embed.setDescription(`**Plantador Atual:** <@${state.activePlanterId}>\n**Rotação:** ${state.rotation} de 2\n\n${statusText}`);
        }

        const rowButtons = new ActionRowBuilder();

        const btnPlant = new ButtonBuilder()
            .setCustomId('btn_plantar')
            .setLabel(state.rotation === 1 ? 'Re-plantei (2ª Rotação)' : 'Plantei Packs (Iniciar)')
            .setStyle(ButtonStyle.Success);

        const btnNext = new ButtonBuilder()
            .setCustomId('btn_passar')
            .setLabel('Passar a vez')
            .setStyle(ButtonStyle.Primary);

        rowButtons.addComponents(btnPlant, btnNext);

        await message.edit({ embeds: [embed], components: [rowButtons] });
    } catch (error) {
        console.error('Erro ao atualizar o painel:', error);
    }
}

// Verifica periodicamente se o tempo acabou
setInterval(async () => {
    if (state.activePlanterId && state.finishTime && !state.notified) {
        if (Date.now() >= state.finishTime) {
            state.notified = true;
            saveData();
            
            try {
                const channel = await client.channels.fetch(state.panelChannelId);
                if (channel) {
                    await channel.send(`🔔 <@${state.activePlanterId}>, seus packs envelhecidos estão prontos! Não se esqueça de colher!`);
                }
            } catch (err) {
                console.error('Erro ao notificar:', err);
            }
            
            updatePanel();
        }
    }
}, CHECK_INTERVAL);

client.once('ready', () => {
    console.log(`Bot logado como ${client.user.tag}`);
    loadData();
    updatePanel();
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!painel') {
        const embed = new EmbedBuilder()
            .setTitle('🌿 Rotação de Packs Envelhecidos')
            .setDescription('Carregando...')
            .setColor('#2ecc71');

        const sentMessage = await message.channel.send({ embeds: [embed] });
        
        state.panelChannelId = sentMessage.channel.id;
        state.panelMessageId = sentMessage.id;
        saveData();
        
        updatePanel();
        
        if (message.deletable) message.delete();
    }
    
    // Comando para setar o ID da role @Packs
    if (message.content.startsWith('!setrole')) {
        const role = message.mentions.roles.first();
        if (role) {
            state.rolePacksId = role.id;
            saveData();
            message.reply(`Cargo @Packs configurado com sucesso: ${role.name}`);
        } else {
            message.reply('Você precisa mencionar um cargo. Ex: `!setrole @Packs`');
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.customId === 'btn_plantar') {
            if (state.activePlanterId && state.activePlanterId !== interaction.user.id && state.rotation > 0) {
                return interaction.reply({ content: 'Apenas a pessoa que está na vez pode replantar, ou passem a vez.', ephemeral: true });
            }

            let nextRotation = 1;
            if (state.activePlanterId === interaction.user.id) {
                nextRotation = state.rotation === 1 ? 2 : 1;
            }

            state.activePlanterId = interaction.user.id;
            state.rotation = nextRotation;
            state.finishTime = Date.now() + THREE_DAYS_MS;
            state.notified = false;
            saveData();

            await interaction.reply({ content: `Packs plantados! Rotação ${state.rotation}. Tempo iniciado: 3 dias.`, ephemeral: true });
            updatePanel();
        }

        if (interaction.customId === 'btn_passar') {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_next')
                .setPlaceholder('Selecione quem será o próximo')
                .addOptions([
                    { label: 'Elu', value: 'elu' },
                    { label: 'Trollei', value: 'trollei' },
                    { label: 'Tock', value: 'tock' }
                ]);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({ 
                content: 'Selecione quem fará a próxima plantação:', 
                components: [row],
                ephemeral: true 
            });
        }
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_next') {
            const selected = interaction.values[0];
            const roleMention = state.rolePacksId ? `<@&${state.rolePacksId}>` : '@everyone (cargo não configurado, use !setrole)';
            
            let pessoaName = '';
            if (selected === 'elu') pessoaName = 'Elu';
            if (selected === 'trollei') pessoaName = 'Trollei';
            if (selected === 'tock') pessoaName = 'Tock';

            state.activePlanterId = null;
            state.rotation = 0;
            state.finishTime = null;
            state.notified = false;
            saveData();

            await interaction.update({ content: `Próximo selecionado: ${pessoaName}. O painel foi atualizado.`, components: [] });
            
            const channel = interaction.channel;
            if (channel) {
                await channel.send(`${roleMention} O terreno está livre! A próxima pessoa na rotação é: **${pessoaName}**. Pode ir lá plantar e clicar em "Plantei Packs" no painel.`);
            }
            
            updatePanel();
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
