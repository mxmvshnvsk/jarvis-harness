import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// GitHub Pages serves the site under the repository's name; DOCS_BASE overrides it (a fork, a custom domain)
const base = process.env.DOCS_BASE ?? "/jarvis-harness/";

export default withMermaid(
  defineConfig({
    lang: "ru-RU",
    title: "Jarvis",
    description: "Проводит инженерную задачу от тикета до проверенного изменения: агенты, проверки и человек там, где нужно решение.",
    base,
    cleanUrls: true,
    lastUpdated: true,
    head: [["link", { rel: "icon", type: "image/svg+xml", href: `${base}logo.svg` }]],
    themeConfig: {
      logo: "/logo.svg",
      nav: [
        { text: "Начать", link: "/guide/start" },
        { text: "Как работает", link: "/guide/how" },
        { text: "Архитектура", link: "/architecture/" },
        { text: "Агенты", link: "/agents/" },
      ],
      sidebar: [
        {
          text: "Знакомство",
          items: [
            { text: "Что такое Jarvis", link: "/guide/what" },
            { text: "Быстрый старт", link: "/guide/start" },
          ],
        },
        {
          text: "Работа с задачей",
          items: [
            { text: "Как проходит задача", link: "/guide/how" },
            { text: "Где решает человек", link: "/guide/human" },
            { text: "Знания проекта", link: "/guide/knowledge" },
          ],
        },
        {
          text: "Настройка",
          items: [
            { text: "Машина и модели", link: "/setup/machine" },
            { text: "Проект и команда", link: "/setup/project" },
            { text: "Скиллы", link: "/setup/skills" },
            { text: "Сценарии задач", link: "/setup/workflows" },
            { text: "Много сервисов", link: "/setup/services" },
          ],
        },
        {
          text: "Как устроено",
          items: [
            { text: "Архитектура", link: "/architecture/" },
            { text: "Поток данных", link: "/architecture/data" },
            { text: "Надёжность и безопасность", link: "/architecture/safety" },
          ],
        },
        {
          text: "Агенты",
          items: [
            { text: "Какие агенты есть", link: "/agents/" },
            { text: "Как промпт настраивает агента", link: "/agents/prompts" },
          ],
        },
      ],
      outline: { level: [2, 3], label: "На странице" },
      search: {
        provider: "local",
        options: {
          translations: {
            button: { buttonText: "Поиск", buttonAriaLabel: "Поиск" },
            modal: {
              noResultsText: "Ничего не нашлось",
              resetButtonTitle: "Сбросить",
              footer: { selectText: "выбрать", navigateText: "перейти", closeText: "закрыть" },
            },
          },
        },
      },
      socialLinks: [{ icon: "github", link: "https://github.com/mxmvshnvsk/jarvis-harness" }],
      editLink: {
        pattern: "https://github.com/mxmvshnvsk/jarvis-harness/edit/main/site/:path",
        text: "Поправить страницу",
      },
      docFooter: { prev: "Назад", next: "Дальше" },
      lastUpdated: { text: "Обновлено" },
      darkModeSwitchLabel: "Тема",
      sidebarMenuLabel: "Меню",
      returnToTopLabel: "Наверх",
      footer: { message: "Apache-2.0" },
    },
    mermaid: {
      securityLevel: "strict",
      fontSize: 15,
      // sequence diagrams of up to six parties fit the text column: messages wrap instead of widening it
      sequence: { wrap: true, width: 120, actorMargin: 28, boxMargin: 8, messageFontSize: 15, actorFontSize: 15, noteFontSize: 14 },
      flowchart: { nodeSpacing: 28, rankSpacing: 36 },
    },
    vite: {
      // mermaid is one large chunk, loaded only on pages with a diagram
      build: { chunkSizeWarningLimit: 4000 },
      // the dev server: mermaid's CommonJS dependencies, nested where pnpm keeps them, bundled up front —
      // served as they are, dayjs has no default export and no page opens
      optimizeDeps: {
        include: [
          "mermaid",
          "vitepress-plugin-mermaid > mermaid > dayjs",
          "vitepress-plugin-mermaid > mermaid > @braintree/sanitize-url",
          "vitepress-plugin-mermaid > mermaid > cytoscape",
          "vitepress-plugin-mermaid > mermaid > cytoscape-cose-bilkent",
        ],
      },
    },
  }),
);
