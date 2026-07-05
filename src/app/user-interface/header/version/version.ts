import './version.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';

declare const __MCS_VERSION__: string;

declare global {
    interface HTMLElementTagNameMap {
        'mcs-header-version': Version;
    }
}

@LoadTemplate('app/user-interface/header/version/version.html')
export class Version extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _version: HTMLElement;
    private readonly _close: HTMLButtonElement;
    private readonly _simulate: HTMLButtonElement;
    private readonly _configuration: HTMLButtonElement;
    private readonly _summary: HTMLButtonElement;
    private readonly _modifiers: HTMLButtonElement;

    private readonly _toth: HTMLDivElement;
    private readonly _aod: HTMLDivElement;
    private readonly _ita: HTMLDivElement;

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-header-version-template'));

        this._version = getElementFromFragment(this._content, 'mcs-header-version', 'small');
    }

    public connectedCallback() {
        // context.version is supplied by mod.io for published mods; sideloaded/dev builds
        // don't have it, so fall back to the package version baked in at build time.
        this._version.innerText = `v${Global.context.version ?? __MCS_VERSION__}`;

        this.appendChild(this._content);
    }
}

customElements.define('mcs-header-version', Version);
