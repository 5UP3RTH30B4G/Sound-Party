# 🎵 Sound Party

Une application web collaborative qui permet à plusieurs utilisateurs de contrôler Spotify ensemble en temps réel.

## ✨ Fonctionnalités

- 🔐 **Authentification Spotify OAuth** - Connexion sécurisée avec votre compte Spotify
- 👥 **Multi-utilisateurs** - Plusieurs personnes peuvent se connecter simultanément
- 🎮 **Contrôles synchronisés** - Play, pause, chanson suivante/précédente en temps réel
- 📋 **File d'attente collaborative** - Ajoutez des chansons que tout le monde peut voir
- 🔍 **Recherche partagée** - Recherchez et partagez des résultats avec les autres
- 💬 **Chat en temps réel** - Communiquez avec les autres utilisateurs
- 📱 **Interface responsive** - Fonctionne sur ordinateur, tablette et mobile
- 🎨 **Thème Spotify** - Interface sombre avec les couleurs de Spotify

## 🛠️ Technologies utilisées

### Backend
- **Node.js** + **Express** - Serveur API
- **Socket.IO** - Communication temps réel
- **Axios** - Requêtes HTTP vers l'API Spotify
- **Cookie-parser** - Gestion des sessions

### Frontend
- **React** - Interface utilisateur
- **Material-UI (MUI)** - Composants et thème
- **Socket.IO Client** - Communication temps réel
- **React Router** - Navigation

### API
- **Spotify Web API** - Contrôle de la lecture et recherche

## 📋 Prérequis

1. **Node.js** (version 16 ou supérieure)
2. **Compte Spotify Premium** (requis pour contrôler la lecture)
3. **Application Spotify** créée sur le [Spotify Developer Dashboard](https://developer.spotify.com/)

## 🎮 Utilisation

1. **Ouvrez Spotify** sur un appareil (ordinateur, téléphone, etc.)
2. **Accédez à l'application** : http://127.0.0.1:3000
3. **Connectez-vous** avec votre compte Spotify
4. **Invitez des amis** en partageant l'URL
5. **Contrôlez la musique** ensemble !

## ⚠️ Notes importantes

- **Spotify Premium requis** : Seuls les comptes Premium peuvent contrôler la lecture
- **Appareil actif** : Spotify doit être ouvert sur au moins un appareil
- **Permissions** : L'application demande les permissions suivantes :
  - `user-read-private` - Informations de profil
  - `user-read-email` - Adresse email
  - `user-read-playback-state` - État de lecture
  - `user-modify-playback-state` - Contrôle de lecture
  - `user-read-currently-playing` - Chanson actuelle
  - `streaming` - Lecture dans le navigateur

## 🎨 Interface

L'application est organisée en plusieurs sections :

- **🎵 Lecteur principal** - Affiche la chanson actuelle et les contrôles
- **🔍 Recherche** - Recherchez et ajoutez des chansons
- **📋 File d'attente** - Voyez les chansons ajoutées par tous les utilisateurs
- **👥 Utilisateurs connectés** - Liste des personnes connectées
- **💬 Chat** - Communiquez en temps réel

## 🤝 Contribution

1. Forkez le projet
2. Créez une branche pour votre fonctionnalité
3. Committez vos changements
4. Poussez vers la branche
5. Ouvrez une Pull Request

## 📄 Licence

Ce projet est sous licence MIT. Voir le fichier `LICENSE` pour plus de détails.

## 🎉 Crédits

- **Spotify Web API** pour l'intégration musicale
- **Material-UI** pour les composants d'interface
- **Socket.IO** pour la communication temps réel

---

Créé avec ❤️ pour la musique collaborative !
