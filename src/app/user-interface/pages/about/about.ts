import './about.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';

declare const __MCS_BUILD__: string;
declare const __MCS_VERSION__: string;

declare global {
    interface HTMLElementTagNameMap {
        'mcs-about': AboutPage;
    }
}

@LoadTemplate('app/user-interface/pages/about/about.html')
export class AboutPage extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _version: HTMLDivElement;
    private readonly _build: HTMLDivElement;

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-about-page-template'));

        this._version = getElementFromFragment(this._content, 'mcs-about-version', 'div');
        this._build = getElementFromFragment(this._content, 'mcs-about-build', 'div');
    }

    public connectedCallback() {
        // __MCS_BUILD__/__MCS_VERSION__ are build-time literals (webpack DefinePlugin) — safe even
        // though connectedCallback can run during setup. context.version only exists for published
        // mod.io builds, so prefer it and fall back to the packaged version.
        this._version.textContent = `Version: v${Global.context?.version ?? __MCS_VERSION__}`;
        this._build.textContent = `Build: ${__MCS_BUILD__}`;

        this.appendChild(this._content);
    }
}

customElements.define('mcs-about', AboutPage);
