"use strict";

const titleElement = document.querySelector(".title");
const buttonsContainer = document.querySelector(".buttons");
const yesButton = document.querySelector(".btn--yes");
const noButton = document.querySelector(".btn--no");
const catImg = document.querySelector(".cat-img");

const MAX_IMAGES = 5;

let play = true;
let noCount = 0;

yesButton.addEventListener("click", handleYesClick);

noButton.addEventListener("click", function () {
  if (play) {
    noCount++;
    const imageIndex = Math.min(noCount, MAX_IMAGES);
    changeImage(imageIndex);
    resizeYesButton();
    updateNoButtonText();
    moveNoButton(); // Llama a la nueva función para mover el botón "No".
    if (noCount === MAX_IMAGES) {
      play = false;
    }
  }
});

function handleYesClick() {
  titleElement.innerHTML = "Yayyy!! :3";
  buttonsContainer.classList.add("hidden");
  changeImage("yes");
}

function resizeYesButton() {
  const computedStyle = window.getComputedStyle(yesButton);
  const fontSize = parseFloat(computedStyle.getPropertyValue("font-size"));
  const newFontSize = fontSize * 1.6;

  yesButton.style.fontSize = `${newFontSize}px`;
}

function generateMessage(noCount) {
  const messages = [
    "No",
    "Estás segura?",
    "Por favoooor",
    "No me hagas esto :(",
    "Me rompes el kokoro",
    "Woa llorar ih ih, ih ih",
  ];

  const messageIndex = Math.min(noCount, messages.length - 1);
  return messages[messageIndex];
}

function changeImage(image) {
  // Comprueba si el argumento `image` es "yes" para mostrar el GIF
  if (image === "yes") {
    catImg.src = `img/cat-happy.gif`; // Asegúrate de que la ruta y el nombre del archivo coincidan con tu GIF
  } else {
    // Si no es "yes", asume que es un intento de cambiar a otra imagen de gato basada en noCount
    catImg.src = `img/cat-${image}.jpg`; // Esto mantiene la lógica original para las imágenes estáticas
  }
}

function updateNoButtonText() {
  noButton.innerHTML = generateMessage(noCount);
}

function moveNoButton() {
  // Calcula los límites máximos para la nueva posición del botón "No"
  const maxX = buttonsContainer.clientWidth - noButton.offsetWidth;
  const maxY = buttonsContainer.clientHeight - noButton.offsetHeight;

  // Genera posiciones aleatorias dentro de esos límites
  const randomX = Math.random() * maxX;
  const randomY = Math.random() * maxY;

  // Aplica las posiciones aleatorias al botón "No"
  noButton.style.position = 'absolute';
  noButton.style.left = `${randomX}px`;
  noButton.style.top = `${randomY}px`;
}

